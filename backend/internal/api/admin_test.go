package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"journal/internal/auth"
	"journal/internal/store"
)

func TestNonAdminBlockedFromAdmin(t *testing.T) {
	env := newEnv(t)
	env.signup("admin")
	bob := env.activeUser("bob")
	carol := env.signup("carol") // no second factor
	adminID := env.userID("admin")
	for _, c := range []*client{bob.c, carol.c} {
		for _, tc := range []struct{ method, path string }{
			{"GET", "/api/admin/users"},
			{"GET", "/api/admin/stats"},
			{"POST", "/api/admin/users/" + adminID + "/disable"},
			{"DELETE", "/api/admin/users/" + adminID},
		} {
			if r := c.do(tc.method, tc.path, nil); r.status != 403 || r.errCode() != "forbidden" {
				t.Errorf("%s %s: %d %s", tc.method, tc.path, r.status, r.body)
			}
		}
	}
}

func TestAdminActionRules(t *testing.T) {
	env := newEnv(t)
	admin := env.signup("admin")
	env.enableTOTP(admin)
	bob := env.signup("bob")
	bobID := env.userID("bob")
	adminID := env.userID("admin")

	// Members are active straight away and don't need a second factor to sync.
	bob.c.mustStatus(200, "GET", "/api/entries", nil)
	env.enableTOTP(bob)

	var users []map[string]any
	mustUnmarshal(t, admin.c.mustStatus(200, "GET", "/api/admin/users", nil).body, &users)
	if len(users) != 2 {
		t.Fatalf("users: %v", users)
	}
	b := users[1]
	for k, want := range map[string]any{
		"username": "bob", "status": "active", "isAdmin": false, "totpEnabled": true, "hasSecondFactor": true,
		"passkeyCount": float64(0), "note": "hello",
	} {
		if b[k] != want {
			t.Errorf("%s = %v, want %v", k, b[k], want)
		}
	}
	if b["approvedAt"] == nil || b["createdAt"] == nil {
		t.Errorf("timestamps missing: %v", b)
	}

	cases := []struct {
		name   string
		method string
		path   string
		want   int
		code   string
	}{
		{"approve is gone", "POST", "/api/admin/users/" + bobID + "/approve", 404, "not_found"},
		{"decline is gone", "POST", "/api/admin/users/" + bobID + "/decline", 404, "not_found"},
		{"enable active", "POST", "/api/admin/users/" + bobID + "/enable", 409, "invalid_status"},
		{"self disable", "POST", "/api/admin/users/" + adminID + "/disable", 400, "self_action"},
		{"self delete", "DELETE", "/api/admin/users/" + adminID, 400, "self_action"},
		{"self enable", "POST", "/api/admin/users/" + adminID + "/enable", 400, "self_action"},
		{"unknown action", "POST", "/api/admin/users/" + bobID + "/explode", 404, "not_found"},
		{"unknown user", "POST", "/api/admin/users/" + newUUID() + "/disable", 404, "not_found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := admin.c.do(tc.method, tc.path, nil)
			if r.status != tc.want || r.errCode() != tc.code {
				t.Fatalf("got %d %s", r.status, r.body)
			}
		})
	}

	// Disable revokes sessions.
	admin.c.mustStatus(200, "POST", "/api/admin/users/"+bobID+"/disable", nil)
	bob.c.mustStatus(401, "GET", "/api/me", nil)
	var n int
	env.st.DB().QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, bobID).Scan(&n)
	if n != 0 {
		t.Fatalf("disabled user still has %d sessions", n)
	}
	admin.c.mustStatus(200, "POST", "/api/admin/users/"+bobID+"/enable", nil)
	env.clock.Advance(time.Minute)
	if r := bob.login(); r.status != 200 {
		t.Fatalf("login after enable: %d %s", r.status, r.body)
	}

	env.signup("carol")
	stats := admin.c.mustStatus(200, "GET", "/api/admin/stats", nil).json(t)
	if stats["members"] != float64(3) || stats["pending"] != nil {
		t.Fatalf("stats: %v", stats)
	}

	// Delete removes the user and their content.
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+bobID, nil)
	if _, err := env.st.UserByID(context.Background(), bobID); err != store.ErrNotFound {
		t.Fatalf("deleted user still exists: %v", err)
	}
}

func TestAdminStorageBytes(t *testing.T) {
	env := newEnv(t)
	admin := env.signup("admin")
	insertCredential(t, env, "admin", "Key")
	admin.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(100), "body": sealed(200)})
	seedBlob(t, env, "admin", newUUID(), "", make([]byte, 1000))
	stats := admin.c.mustStatus(200, "GET", "/api/admin/stats", nil).json(t)
	// 100+200 ct + 2×12 nonces + 1000 blob.
	if stats["storageBytes"] != float64(1324) {
		t.Fatalf("storageBytes = %v", stats["storageBytes"])
	}
}

func TestTOTPEnableCodeCannotBeReused(t *testing.T) {
	// A member's TOTP codes enforce replay protection.
	env := newEnv(t)
	env.signup("admin")
	p := env.signup("pat")
	sec := env.enableTOTP(p)
	code, _ := auth.TOTPCode(sec, env.clock.Now())
	if r := p.c.do("POST", "/api/totp/disable", map[string]any{"code": code}); r.status != 401 {
		t.Fatalf("reused enable code accepted for disable: %d", r.status)
	}
}

// Admin routes that change something need a recent proof of a credential, like changes to
// the admin's own credentials do; reading the lists does not.
func TestAdminChangesNeedRecentAuth(t *testing.T) {
	env := newEnv(t)
	admin := env.signup("admin")
	env.enableTOTP(admin)
	env.signup("bob")
	bobID := env.userID("bob")
	// Minted while the session is fresh.
	invite, _ := admin.c.mustStatus(200, "POST", "/api/admin/invites", map[string]any{"note": "for carol"}).json(t)["id"].(string)

	env.clock.Advance(reauthWindow + time.Second)
	changes := []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/admin/users/" + bobID + "/disable", nil},
		{"POST", "/api/admin/users/" + bobID + "/enable", nil},
		{"POST", "/api/admin/users/" + bobID + "/comp", nil},
		{"POST", "/api/admin/users/" + bobID + "/uncomp", nil},
		{"DELETE", "/api/admin/users/" + bobID, nil},
		{"POST", "/api/admin/invites", map[string]any{"note": "x"}},
		{"DELETE", "/api/admin/invites/" + invite, nil},
	}
	for _, c := range changes {
		if r := admin.c.do(c.method, c.path, c.body); r.status != http.StatusForbidden || r.errCode() != "reauth_required" {
			t.Fatalf("%s %s with a stale session: %d %s", c.method, c.path, r.status, r.body)
		}
	}
	// Nothing happened.
	if u, err := env.st.UserByID(context.Background(), bobID); err != nil || u.Status != store.StatusActive || u.Comped {
		t.Fatalf("bob changed: %+v %v", u, err)
	}
	// Reading still works with the long-lived session.
	for _, path := range []string{"/api/admin/users", "/api/admin/stats", "/api/admin/invites"} {
		admin.c.mustStatus(200, "GET", path, nil)
	}

	// Confirming the passphrase opens the window again.
	admin.c.mustStatus(200, "POST", "/api/auth/reauth", map[string]any{"authKey": admin.authKey})
	admin.c.mustStatus(200, "POST", "/api/admin/users/"+bobID+"/disable", nil)
	admin.c.mustStatus(200, "POST", "/api/admin/invites", map[string]any{"note": "y"})
	admin.c.mustStatus(200, "DELETE", "/api/admin/invites/"+invite, nil)
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+bobID, nil)
}
