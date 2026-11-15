package api

import (
	"errors"
	"net/http"

	"journal/internal/store"
)

type adminUserJSON struct {
	ID              string  `json:"id"`
	Username        string  `json:"username"`
	Note            string  `json:"note"`
	Status          string  `json:"status"`
	IsAdmin         bool    `json:"isAdmin"`
	CreatedAt       string  `json:"createdAt"`
	ApprovedAt      *string `json:"approvedAt"`
	LastActiveAt    *string `json:"lastActiveAt"`
	StorageBytes    int64   `json:"storageBytes"`
	PasskeyCount    int     `json:"passkeyCount"`
	TOTPEnabled     bool    `json:"totpEnabled"`
	HasSecondFactor bool    `json:"hasSecondFactor"`
	Plan            string  `json:"plan"`
	FreeBytes       int64   `json:"freeBytes"`
}

func (s *Server) toAdminUser(u *store.UserSummary) adminUserJSON {
	return adminUserJSON{
		Plan: s.plan(&u.User), FreeBytes: s.cfg.Billing.FreeBytes,
		ID: u.ID, Username: u.Username, Note: u.Note, Status: u.Status, IsAdmin: u.IsAdmin,
		CreatedAt: ts(u.CreatedAt), ApprovedAt: tsPtr(u.ApprovedAt), LastActiveAt: tsPtr(u.LastActiveAt),
		StorageBytes: u.StorageBytes, PasskeyCount: u.PasskeyCount, TOTPEnabled: u.TOTPEnabled(),
		HasSecondFactor: u.HasSecondFactor(),
	}
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) error {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		return err
	}
	out := make([]adminUserJSON, 0, len(users))
	for i := range users {
		out = append(out, s.toAdminUser(&users[i]))
	}
	return writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) error {
	st, err := s.store.Stats(r.Context())
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{
		"members": st.Members, "storageBytes": st.StorageBytes,
	})
}

var (
	errSelfAction = errf(http.StatusBadRequest, "self_action", "admins cannot perform this action on their own account")
	errBadStatus  = errf(http.StatusConflict, "invalid_status", "the user is not in a state that allows this action")
	errNoSecond   = errf(http.StatusConflict, "no_second_factor", "the user must set up a passkey or authenticator app first")
)

// adminTarget loads the target user of an admin action, refusing the caller's own account.
func (s *Server) adminTarget(r *http.Request) (*store.UserSummary, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return nil, err
	}
	if id == caller(r).user.ID {
		return nil, errSelfAction
	}
	u, err := s.store.UserSummaryByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, errNotFound
	}
	return u, err
}

func (s *Server) handleAdminAction(w http.ResponseWriter, r *http.Request) error {
	action := r.PathValue("action")
	switch action {
	case "disable", "enable", "comp", "uncomp":
	default:
		return errNotFound
	}
	target, err := s.adminTarget(r)
	if err != nil {
		return err
	}
	ctx, now := r.Context(), s.cfg.Now()
	switch action {
	case "disable":
		if target.Status == store.StatusDisabled {
			return errBadStatus
		}
		err = s.store.SetStatus(ctx, target.ID, store.StatusDisabled, now)
	case "comp", "uncomp":
		err = s.store.SetComped(ctx, target.ID, action == "comp")
	case "enable":
		if target.Status != store.StatusDisabled {
			return errBadStatus
		}
		err = s.store.SetStatus(ctx, target.ID, store.StatusActive, now)
	}
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	return ok(w)
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) error {
	target, err := s.adminTarget(r)
	if err != nil {
		return err
	}
	if err := s.store.DeleteUser(r.Context(), target.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	// The account is gone; make sure Stripe stops charging for it. Never fails the delete.
	s.cancelSubscriptions(r.Context(), target.ID, target.StripeCustomerID)
	return ok(w)
}
