package api

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Recognised-device cookie (SPEC §5.1 "Recognised devices").
//
// After every full sign-in the server sets `jdev`, a long-lived cookie that names
// a random device id and is MACed (key derived from secret.key) together with the
// user id and its expiry. It grants nothing on its own: it only selects which
// failure counter a wrong passphrase is charged to, so that someone who knows a
// username can lock out unrecognised browsers but not the owner's own devices.
const (
	deviceCookieName = "jdev"
	deviceCookieTTL  = 365 * 24 * time.Hour
	deviceIDLen      = 16
	maxDeviceCookie  = 256
)

// deviceMAC authenticates (userID, deviceID, expiry).
func (s *Server) deviceMAC(userID, deviceID string, expires int64) []byte {
	return s.keys.DeviceMAC([]byte("jdev/v1\x00" + userID + "\x00" + deviceID + "\x00" + strconv.FormatInt(expires, 10)))
}

// parseDeviceCookie splits a well-formed, unexpired jdev cookie into its parts.
// It does not check the MAC, which needs the user id.
func (s *Server) parseDeviceCookie(r *http.Request) (devID string, exp int64, mac []byte, ok bool) {
	c, err := r.Cookie(deviceCookieName)
	if err != nil || c.Value == "" || len(c.Value) > maxDeviceCookie {
		return "", 0, nil, false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return "", 0, nil, false
	}
	devID = parts[0]
	if raw, err := base64.RawURLEncoding.DecodeString(devID); err != nil || len(raw) != deviceIDLen {
		return "", 0, nil, false
	}
	exp, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil || s.cfg.Now().Unix() >= exp {
		return "", 0, nil, false
	}
	mac, err = base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", 0, nil, false
	}
	return devID, exp, mac, true
}

// returningBrowser reports whether the request carries a jdev cookie, i.e. some
// account has signed in on this browser before. It is only a UI hint (land on
// sign-in rather than sign-up), so the MAC is not checked: it is bound to a user
// id this request doesn't name, and a forged cookie only changes the landing page.
func (s *Server) returningBrowser(r *http.Request) bool {
	_, _, _, ok := s.parseDeviceCookie(r)
	return ok
}

// deviceFor returns the device id from the request's jdev cookie if the cookie
// is valid, unexpired and bound to userID; otherwise "".
func (s *Server) deviceFor(r *http.Request, userID string) string {
	devID, exp, mac, ok := s.parseDeviceCookie(r)
	if !ok || !hmac.Equal(mac, s.deviceMAC(userID, devID, exp)) {
		return ""
	}
	return devID
}

// setDeviceCookie (re)issues the jdev cookie for userID, keeping the device id
// of a cookie that is already valid for this user.
func (s *Server) setDeviceCookie(w http.ResponseWriter, r *http.Request, userID string) error {
	devID := s.deviceFor(r, userID)
	if devID == "" {
		raw := make([]byte, deviceIDLen)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		devID = base64.RawURLEncoding.EncodeToString(raw)
	}
	expires := s.cfg.Now().Add(deviceCookieTTL)
	exp := expires.Unix()
	value := devID + "." + strconv.FormatInt(exp, 10) + "." +
		base64.RawURLEncoding.EncodeToString(s.deviceMAC(userID, devID, exp))
	http.SetCookie(w, &http.Cookie{
		Name:     deviceCookieName,
		Value:    value,
		Path:     "/api/",
		Expires:  expires,
		MaxAge:   int(deviceCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteStrictMode,
	})
	return nil
}

// passFailKey selects the failure bucket a wrong passphrase for username is
// charged to: per (user, device) when the request carries a valid device cookie
// for that user, else the account-wide bucket. Unknown usernames use the same
// account-wide key shape, so they lock (and answer) exactly like real accounts.
func (s *Server) passFailKey(r *http.Request, username, userID string) (key string, device bool) {
	if userID != "" {
		if dev := s.deviceFor(r, userID); dev != "" {
			return "dev|" + userID + "|" + dev, true
		}
	}
	return "acct|" + username, false
}
