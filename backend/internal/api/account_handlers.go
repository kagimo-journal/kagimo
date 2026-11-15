package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"journal/internal/auth"
	"journal/internal/passkey"
	"journal/internal/store"
	"journal/internal/uuid"
)

// --- /api/me ---

type passkeyJSON struct {
	ID           string  `json:"id"`
	CredentialID string  `json:"credentialId"` // base64url
	Name         string  `json:"name"`
	CreatedAt    string  `json:"createdAt"`
	LastUsedAt   *string `json:"lastUsedAt"`
	PRF          bool    `json:"prf"`
}

type passkeyWrapJSON struct {
	CredentialID string          `json:"credentialId"`
	WrappedMK    json.RawMessage `json:"wrappedMk"`
}

type keysJSON struct {
	KDF           kdfJSON           `json:"kdf"`
	WrappedMKPass json.RawMessage   `json:"wrappedMkPass"`
	PasskeyWraps  []passkeyWrapJSON `json:"passkeyWraps"`
}

type meJSON struct {
	ID              string        `json:"id"`
	Username        string        `json:"username"`
	Status          string        `json:"status"`
	IsAdmin         bool          `json:"isAdmin"`
	TOTPEnabled     bool          `json:"totpEnabled"`
	Passkeys        []passkeyJSON `json:"passkeys"`
	HasSecondFactor bool          `json:"hasSecondFactor"`
	Keys            keysJSON      `json:"keys"`
	Billing         billingJSON   `json:"billing"`
}

func toPasskeyJSON(c *store.Credential) passkeyJSON {
	return passkeyJSON{
		ID:           c.ID,
		CredentialID: b64url(c.CredentialID),
		Name:         c.Name,
		CreatedAt:    ts(c.CreatedAt),
		LastUsedAt:   tsPtr(c.LastUsedAt),
		PRF:          c.WrappedMKPRF != nil,
	}
}

func (s *Server) buildMe(r *http.Request, u *store.User) (*meJSON, error) {
	creds, err := s.store.CredentialsByUser(r.Context(), u.ID)
	if err != nil {
		return nil, err
	}
	bill, err := s.buildBilling(r.Context(), u)
	if err != nil {
		return nil, err
	}
	me := &meJSON{
		ID:              u.ID,
		Username:        u.Username,
		Status:          u.Status,
		IsAdmin:         u.IsAdmin,
		TOTPEnabled:     u.TOTPEnabled(),
		Passkeys:        make([]passkeyJSON, 0, len(creds)),
		HasSecondFactor: u.TOTPEnabled() || len(creds) > 0,
		Billing:         bill,
		Keys: keysJSON{
			KDF:           kdfJSON{Salt: b64(u.KDF.Salt), M: u.KDF.M, T: u.KDF.T, P: u.KDF.P},
			WrappedMKPass: json.RawMessage(u.WrappedMKPass),
			PasskeyWraps:  []passkeyWrapJSON{},
		},
	}
	for i := range creds {
		c := &creds[i]
		me.Passkeys = append(me.Passkeys, toPasskeyJSON(c))
		if c.WrappedMKPRF != nil {
			me.Keys.PasskeyWraps = append(me.Keys.PasskeyWraps, passkeyWrapJSON{
				CredentialID: b64url(c.CredentialID),
				WrappedMK:    json.RawMessage(*c.WrappedMKPRF),
			})
		}
	}
	return me, nil
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) error {
	me, err := s.buildMe(r, caller(r).user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, me)
}

// --- passkey registration & management ---

const maxPasskeyName = 64

var errPasskeyLimit = errf(http.StatusConflict, "passkey_limit",
	"this account already has %d passkeys; remove one before adding another", store.MaxCredentials)

func passkeyName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "Passkey", nil
	}
	if utf8.RuneCountInString(s) > maxPasskeyName {
		return "", badRequest("name must be at most %d characters", maxPasskeyName)
	}
	return s, nil
}

func (s *Server) webauthnUser(r *http.Request, u *store.User) (*passkey.User, error) {
	creds, err := s.store.CredentialsByUser(r.Context(), u.ID)
	if err != nil {
		return nil, err
	}
	return &passkey.User{Account: u, Creds: creds}, nil
}

type nameReq struct {
	Name string `json:"name"`
}

func (s *Server) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) error {
	var req nameReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if _, err := passkeyName(req.Name); err != nil {
		return err
	}
	rc := caller(r)
	wu, err := s.webauthnUser(r, rc.user)
	if err != nil {
		return err
	}
	if len(wu.Creds) >= store.MaxCredentials {
		return errPasskeyLimit
	}
	requireRK := true
	options, data, err := s.wa.BeginRegistration(wu,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			RequireResidentKey: &requireRK,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationPreferred,
		}),
		webauthn.WithExclusions(wu.Descriptors()),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
	)
	if err != nil {
		return err
	}
	id, err := s.challenges.Put(passkey.KindRegister, rc.user.ID, challengeOwnerUser(rc.user.ID), *data)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"challengeId": id, "options": options})
}

func (s *Server) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) error {
	var req passkeyFinishReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	name, err := passkeyName(req.Name)
	if err != nil {
		return err
	}
	rc := caller(r)
	data, err := s.challenges.Take(req.ChallengeID, passkey.KindRegister, rc.user.ID)
	if err != nil {
		return errf(http.StatusBadRequest, "challenge_expired", "registration timed out, please try again")
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		return errf(http.StatusBadRequest, "webauthn_invalid", "malformed passkey response")
	}
	wu, err := s.webauthnUser(r, rc.user)
	if err != nil {
		return err
	}
	cred, err := s.wa.CreateCredential(wu, data, parsed)
	if err != nil {
		return errf(http.StatusBadRequest, "webauthn_failed", "passkey registration could not be verified")
	}
	row := passkey.FromLibrary(cred)
	row.ID = uuid.New()
	row.UserID = rc.user.ID
	row.Name = name
	row.CreatedAt = s.cfg.Now()
	if err := s.store.CreateCredential(r.Context(), &row); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return errf(http.StatusConflict, "passkey_exists", "this passkey is already registered")
		}
		if errors.Is(err, store.ErrTooManyCredentials) {
			return errPasskeyLimit
		}
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"passkey": toPasskeyJSON(&row)})
}

type prfReq struct {
	WrappedMK json.RawMessage `json:"wrappedMk"`
}

func (s *Server) handlePasskeySetPRF(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	var req prfReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	wrapped, err := wrappedKey("wrappedMk", req.WrappedMK)
	if err != nil {
		return err
	}
	if err := s.store.SetCredentialPRF(r.Context(), caller(r).user.ID, id, wrapped); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	return ok(w)
}

func (s *Server) handlePasskeyRename(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	var req nameReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	name, err := passkeyName(req.Name)
	if err != nil {
		return err
	}
	uid := caller(r).user.ID
	if err := s.store.RenameCredential(r.Context(), uid, id, name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	c, err := s.store.CredentialForUser(r.Context(), uid, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"passkey": toPasskeyJSON(c)})
}

// Only administrators must keep a second factor; members may remove their last one.
var errLastSecondFactor = errf(http.StatusConflict, "last_second_factor",
	"administrators need a second factor; add another before removing this one")

func (s *Server) handlePasskeyDelete(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	u := caller(r).user
	creds, err := s.store.CredentialsByUser(r.Context(), u.ID)
	if err != nil {
		return err
	}
	owned := false
	for _, c := range creds {
		owned = owned || c.ID == id
	}
	if !owned {
		return errNotFound
	}
	if u.IsAdmin && u.Status == store.StatusActive && !u.TOTPEnabled() && len(creds) == 1 {
		return errLastSecondFactor
	}
	if err := s.store.DeleteCredential(r.Context(), u.ID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	return ok(w)
}

// --- TOTP management ---

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) error {
	u := caller(r).user
	if u.TOTPEnabled() {
		return errf(http.StatusConflict, "totp_already_enabled", "two-factor codes are already enabled")
	}
	secretStr, url, err := auth.NewTOTPSecret(s.cfg.RPName, u.Username)
	if err != nil {
		return err
	}
	enc, err := s.keys.Seal([]byte(secretStr), totpAAD(u.ID))
	if err != nil {
		return err
	}
	if err := s.store.SetPendingTOTP(r.Context(), u.ID, enc); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"secret": secretStr, "otpauthUrl": url})
}

func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) error {
	u := caller(r).user
	if err := s.rateLimit(r, "totp", u.Username); err != nil {
		return err
	}
	var req codeReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if u.TOTPEnabled() {
		return errf(http.StatusConflict, "totp_already_enabled", "two-factor codes are already enabled")
	}
	if len(u.TOTPPendingEnc) == 0 {
		return errf(http.StatusConflict, "totp_not_setup", "start two-factor setup first")
	}
	secretBytes, err := s.keys.Open(u.TOTPPendingEnc, totpAAD(u.ID))
	if err != nil {
		return err
	}
	if err := s.consumeTOTP(r, u, string(secretBytes), req.Code, false); err != nil {
		return err
	}
	if err := s.store.EnableTOTP(r.Context(), u.ID); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return errf(http.StatusConflict, "totp_not_setup", "start two-factor setup first")
		}
		return err
	}
	return ok(w)
}

func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) error {
	u := caller(r).user
	if err := s.rateLimit(r, "totp", u.Username); err != nil {
		return err
	}
	var req codeReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if err := s.checkTOTP(r, u, req.Code, true); err != nil {
		return err
	}
	if u.IsAdmin && u.Status == store.StatusActive {
		creds, err := s.store.CredentialsByUser(r.Context(), u.ID)
		if err != nil {
			return err
		}
		if len(creds) == 0 {
			return errLastSecondFactor
		}
	}
	if err := s.store.DisableTOTP(r.Context(), u.ID); err != nil {
		return err
	}
	return ok(w)
}

// --- passphrase & recovery key ---

type changePassphraseReq struct {
	CurrentAuthKey string          `json:"currentAuthKey"`
	KDF            *kdfJSON        `json:"kdf"`
	AuthKey        string          `json:"authKey"`
	WrappedMKPass  json.RawMessage `json:"wrappedMkPass"`
}

func (s *Server) handleChangePassphrase(w http.ResponseWriter, r *http.Request) error {
	rc := caller(r)
	if err := s.rateLimit(r, "passphrase", rc.user.Username); err != nil {
		return err
	}
	var req changePassphraseReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	current, err := key32("currentAuthKey", req.CurrentAuthKey)
	if err != nil {
		return err
	}
	salt, err := req.KDF.validate()
	if err != nil {
		return err
	}
	authKey, err := key32("authKey", req.AuthKey)
	if err != nil {
		return err
	}
	wrapped, err := wrappedKey("wrappedMkPass", req.WrappedMKPass)
	if err != nil {
		return err
	}
	if err := s.checkPassphrase(r, rc.user.Username, true, rc.user, current); err != nil {
		if errors.Is(err, errBadCredentials) {
			return errf(http.StatusUnauthorized, "invalid_credentials", "current passphrase is incorrect")
		}
		return err
	}
	authHash, err := auth.HashSecret(r.Context(), authKey)
	if err != nil {
		return err
	}
	kdf := store.KDF{Salt: salt, M: req.KDF.M, T: req.KDF.T, P: req.KDF.P}
	if err := s.store.UpdatePassphrase(r.Context(), rc.user.ID, kdf, authHash, wrapped); err != nil {
		return err
	}
	// Sign out every other device.
	if err := s.store.DeleteUserSessions(r.Context(), rc.user.ID, rc.sess.IDHash); err != nil {
		return err
	}
	// The current passphrase was just proved.
	if err := s.store.MarkSessionAuthenticated(r.Context(), rc.sess.IDHash, s.cfg.Now()); err != nil {
		return err
	}
	return ok(w)
}

type regenerateRecoveryReq struct {
	RecoveryAuthKey   string          `json:"recoveryAuthKey"`
	WrappedMKRecovery json.RawMessage `json:"wrappedMkRecovery"`
}

func (s *Server) handleRegenerateRecovery(w http.ResponseWriter, r *http.Request) error {
	var req regenerateRecoveryReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	recKey, err := key32("recoveryAuthKey", req.RecoveryAuthKey)
	if err != nil {
		return err
	}
	wrapped, err := wrappedKey("wrappedMkRecovery", req.WrappedMKRecovery)
	if err != nil {
		return err
	}
	hash, err := auth.HashSecret(r.Context(), recKey)
	if err != nil {
		return err
	}
	if err := s.store.UpdateRecovery(r.Context(), caller(r).user.ID, hash, wrapped); err != nil {
		return err
	}
	return ok(w)
}
