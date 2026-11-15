package api

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"journal/internal/auth"
	"journal/internal/passkey"
	"journal/internal/store"
	"journal/internal/uuid"
)

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) error {
	n, err := s.store.CountUsers(r.Context())
	if err != nil {
		return err
	}
	cfg := map[string]any{
		"rpId":      s.cfg.RPID,
		"rpName":    s.cfg.RPName,
		"bootstrap": n == 0,
		"returning": s.returningBrowser(r),
		"billing":   s.planJSON(),
	}
	if d := s.downloads(); len(d) > 0 {
		cfg["downloads"] = d
	}
	return writeJSON(w, http.StatusOK, cfg)
}

// --- prelogin / login ---

type preloginReq struct {
	Username string `json:"username"`
}

func (s *Server) handlePrelogin(w http.ResponseWriter, r *http.Request) error {
	var req preloginReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	username, valid := loginUsername(req.Username)
	if err := s.rateLimit(r, "prelogin", username); err != nil {
		return err
	}
	// Always compute the fake salt so known and unknown usernames cost the same.
	kdf := kdfJSON{Salt: b64(s.keys.FakeSalt(username)), M: kdfDefaultM, T: kdfDefaultT, P: kdfDefaultP}
	if valid {
		u, err := s.store.UserByUsername(r.Context(), username)
		switch {
		case err == nil:
			kdf = kdfJSON{Salt: b64(u.KDF.Salt), M: u.KDF.M, T: u.KDF.T, P: u.KDF.P}
		case !errors.Is(err, store.ErrNotFound):
			return err
		}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"kdf": kdf})
}

type loginReq struct {
	Username string `json:"username"`
	AuthKey  string `json:"authKey"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) error {
	var req loginReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	username, valid := loginUsername(req.Username)
	if err := s.rateLimit(r, "login", username); err != nil {
		return err
	}
	authKey, err := key32("authKey", req.AuthKey)
	if err != nil {
		return err
	}
	user, err := s.lookupUser(r, username, valid)
	if err != nil {
		return err
	}
	if err := s.checkPassphrase(r, username, valid, user, authKey); err != nil {
		return err
	}
	if user.Status == store.StatusDisabled {
		return errDisabled
	}
	// The passphrase is one factor. An account with a second factor must complete
	// it before it gets a full session (SPEC §5 "Sign-in").
	passkeys, err := s.store.CountCredentials(r.Context(), user.ID)
	if err != nil {
		return err
	}
	var body map[string]any
	switch {
	case user.TOTPEnabled() && passkeys > 0:
		body = map[string]any{"status": "totp_required", "passkeyAllowed": true}
	case user.TOTPEnabled():
		body = map[string]any{"status": "totp_required"}
	case passkeys > 0:
		body = map[string]any{"status": "passkey_required"}
	default:
		// No second factor yet (bootstrap admin, or any member):
		// a full session, but withSession keeps it to the "any status" endpoints
		// until a passkey or TOTP is set up.
		return s.completeLogin(w, r, user)
	}
	if err := s.startSession(w, r, user.ID, store.SessionMFAPending); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, body)
}

// lookupUser loads the account for a normalised username; nil if it does not
// exist or the username is not valid.
func (s *Server) lookupUser(r *http.Request, username string, valid bool) (*store.User, error) {
	if !valid {
		return nil, nil
	}
	u, err := s.store.UserByUsername(r.Context(), username)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	return u, err
}

// checkPassphrase verifies authKey for user (nil = unknown username) and counts
// failures independently of the caller's IP (SPEC §5.1 "Rate limits"):
//   - a request carrying a valid recognised-device cookie for this user is charged
//     to that device's own bucket (devFail) and is never blocked by the account lock;
//   - every other request is charged to the account bucket (passFail), keyed by
//     username. Unknown (but well-formed) usernames are counted exactly like real
//     accounts, so 401 vs 429 and the timing do not reveal whether one exists.
//
// While the selected bucket is exhausted, even the right passphrase is refused
// with rate_limited. An equivalent hash is computed on every path (or, when the
// server is hashing as many as it allows at once, none is and the answer is 503 busy).
func (s *Server) checkPassphrase(r *http.Request, username string, valid bool, user *store.User, authKey []byte) error {
	uid := ""
	if user != nil {
		uid = user.ID
	}
	key, device := s.passFailKey(r, username, uid)
	lim := s.passFail
	if device {
		lim = s.devFail
	}
	if lim.Exhausted(key) {
		if err := auth.BurnVerify(r.Context(), authKey); err != nil {
			return err
		}
		return errRateLimited
	}
	if user == nil {
		if err := auth.BurnVerify(r.Context(), authKey); err != nil {
			return err
		}
		if valid {
			lim.Allow(key)
		}
		return errBadCredentials
	}
	match, err := auth.VerifySecret(r.Context(), user.AuthHash, authKey)
	if err != nil {
		return err
	}
	if !match {
		lim.Allow(key)
		return errBadCredentials
	}
	return nil
}

// completeLogin starts a full session, (re)issues the recognised-device cookie
// and responds {status:"ok", me}.
func (s *Server) completeLogin(w http.ResponseWriter, r *http.Request, user *store.User) error {
	if err := s.startSession(w, r, user.ID, store.SessionFull); err != nil {
		return err
	}
	if err := s.setDeviceCookie(w, r, user.ID); err != nil {
		return err
	}
	me, err := s.buildMe(r, user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "me": me})
}

type codeReq struct {
	Code string `json:"code"`
}

func (s *Server) handleLoginTOTP(w http.ResponseWriter, r *http.Request) error {
	rc := caller(r)
	if err := s.rateLimit(r, "totp", rc.user.Username); err != nil {
		return err
	}
	var req codeReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if err := s.checkTOTP(r, rc.user, req.Code, true); err != nil {
		if errors.Is(err, errInvalidTOTP) {
			if derr := s.mfaStepFailed(w, r, rc); derr != nil {
				return derr
			}
		}
		return err
	}
	return s.completeLogin(w, r, rc.user)
}

// mfaStepFailed bounds the guesses per sign-in attempt: after mfaSessionFail
// wrong second-step answers (TOTP codes or passkey assertions) the mfa_pending
// session is deleted and the passphrase step has to be repeated. The count is kept in
// the session row, so restarting the server does not hand the session a fresh set.
func (s *Server) mfaStepFailed(w http.ResponseWriter, r *http.Request, rc *reqCtx) error {
	n, err := s.store.FailMFASession(r.Context(), rc.sess.IDHash)
	if errors.Is(err, store.ErrNotFound) {
		// Already discarded by a concurrent wrong answer.
		s.clearCookie(w)
		return nil
	}
	if err != nil {
		return err
	}
	if n >= mfaSessionFail {
		if err := s.store.DeleteSession(r.Context(), rc.sess.IDHash); err != nil {
			return err
		}
		s.clearCookie(w)
	}
	return nil
}

// --- passkey as the second step of a passphrase sign-in ---

var errNoPasskey = errf(http.StatusConflict, "no_passkey", "this account has no passkey")

// handleLoginPasskeyBegin starts a WebAuthn assertion restricted to the
// mfa_pending session's own credentials, with user verification required.
func (s *Server) handleLoginPasskeyBegin(w http.ResponseWriter, r *http.Request) error {
	rc := caller(r)
	if err := s.rateLimit(r, "passkey-mfa", rc.user.Username); err != nil {
		return err
	}
	wu, err := s.webauthnUser(r, rc.user)
	if err != nil {
		return err
	}
	if len(wu.Creds) == 0 {
		return errNoPasskey
	}
	options, data, err := s.wa.BeginLogin(wu, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return err
	}
	id, err := s.challenges.Put(passkey.KindMFA, rc.user.ID, challengeOwnerUser(rc.user.ID), *data)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"challengeId": id, "options": options})
}

// handleLoginPasskeyFinish completes a passphrase sign-in with an assertion from
// one of the session user's passkeys.
func (s *Server) handleLoginPasskeyFinish(w http.ResponseWriter, r *http.Request) error {
	rc := caller(r)
	if err := s.rateLimit(r, "passkey-mfa", rc.user.Username); err != nil {
		return err
	}
	var req passkeyFinishReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	// The challenge is bound to this user, so another account's challenge (or a
	// discoverable-login one) cannot be used here.
	data, err := s.challenges.Take(req.ChallengeID, passkey.KindMFA, rc.user.ID)
	if err != nil {
		return errf(http.StatusBadRequest, "challenge_expired", "sign-in timed out, please try again")
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		return errf(http.StatusBadRequest, "webauthn_invalid", "malformed passkey response")
	}
	wu, err := s.webauthnUser(r, rc.user)
	if err != nil {
		return err
	}
	failed := func(msg string) error {
		if err := s.mfaStepFailed(w, r, rc); err != nil {
			return err
		}
		return errf(http.StatusUnauthorized, "passkey_failed", "%s", msg)
	}
	// ValidateLogin only accepts credentials owned by wu (and listed in the
	// challenge's allowCredentials), and a userHandle, if present, must be wu's.
	cred, err := s.wa.ValidateLogin(wu, data, parsed)
	if err != nil {
		return failed("passkey sign-in failed")
	}
	if !cred.Flags.UserVerified {
		return failed("this passkey did not verify you (PIN or biometric)")
	}
	var stored *store.Credential
	for i := range wu.Creds {
		if bytes.Equal(wu.Creds[i].CredentialID, cred.ID) {
			stored = &wu.Creds[i]
		}
	}
	if stored == nil {
		return failed("passkey sign-in failed")
	}
	if cred.Authenticator.CloneWarning {
		s.log.Warn("passkey sign counter regression; possible cloned authenticator", "user", rc.user.ID, "credential", stored.ID)
		return failed("passkey sign-in failed")
	}
	if err := s.store.RecordCredentialUse(r.Context(), stored.ID, cred.Authenticator.SignCount,
		byte(cred.Flags.ProtocolValue()), s.cfg.Now()); err != nil {
		return err
	}
	return s.completeLogin(w, r, rc.user)
}

type reauthReq struct {
	AuthKey string `json:"authKey"`
}

// handleReauth proves the passphrase again for an existing full session, which
// opens the reauthWindow for security-sensitive account changes.
func (s *Server) handleReauth(w http.ResponseWriter, r *http.Request) error {
	rc := caller(r)
	if err := s.rateLimit(r, "login", rc.user.Username); err != nil {
		return err
	}
	var req reauthReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	authKey, err := key32("authKey", req.AuthKey)
	if err != nil {
		return err
	}
	if err := s.checkPassphrase(r, rc.user.Username, true, rc.user, authKey); err != nil {
		if errors.Is(err, errBadCredentials) {
			return errf(http.StatusUnauthorized, "invalid_credentials", "passphrase is incorrect")
		}
		return err
	}
	if err := s.store.MarkSessionAuthenticated(r.Context(), rc.sess.IDHash, s.cfg.Now()); err != nil {
		return err
	}
	return ok(w)
}

// checkTOTP verifies a code against the user's enabled secret and consumes its
// step. With lockout, the escalating per-account TOTP lockout applies too.
func (s *Server) checkTOTP(r *http.Request, user *store.User, code string, lockout bool) error {
	if !user.TOTPEnabled() {
		return errf(http.StatusConflict, "totp_not_enabled", "two-factor codes are not enabled")
	}
	secret, err := s.keys.Open(user.TOTPSecretEnc, totpAAD(user.ID))
	if err != nil {
		return err
	}
	return s.consumeTOTP(r, user, string(secret), code, lockout)
}

// errTOTPLocked returns the 429 totp_locked error for a locked account.
func errTOTPLocked(until time.Time) error {
	e := errf(http.StatusTooManyRequests, "totp_locked",
		"too many wrong codes: two-factor codes are locked for this account until %s; sign in with a passkey or your recovery key", ts(until))
	e.extra = map[string]any{"lockedUntil": ts(until)}
	return e
}

// consumeTOTP checks code and marks its step used. Wrong codes are counted per
// account across all IPs in two ways (SPEC §5.1 "Rate limits"):
//   - totpFail, a short-term bucket (5 per 10 minutes), answered with rate_limited;
//   - with lockout, totpLock, an escalating lockout (10 wrong codes in 24 h lock
//     codes for 1 h, 20 for 24 h), answered with totp_locked. It applies to every
//     caller, including recognised devices; a correct code resets it. Its state is
//     in the users row, so it holds across restarts.
func (s *Server) consumeTOTP(r *http.Request, user *store.User, secret, code string, lockout bool) error {
	now := s.cfg.Now()
	if lockout {
		if locked, until := totpLockState(user.TOTPFailures).Locked(now); locked {
			return errTOTPLocked(until)
		}
	}
	if s.totpFail.Exhausted(user.ID) {
		return errRateLimited
	}
	fail := func() error {
		s.totpFail.Allow(user.ID)
		if lockout {
			f, err := s.store.UpdateTOTPFailures(r.Context(), user.ID, func(f store.TOTPFailures) store.TOTPFailures {
				st := totpLock.Fail(totpLockState(f), now)
				return store.TOTPFailures{Count: st.Failures, WindowStart: st.WindowStart, LockedUntil: st.LockedUntil}
			})
			if err != nil {
				return err
			}
			user.TOTPFailures = f
		}
		return errInvalidTOTP
	}
	step, ok := auth.MatchTOTP(secret, strings.TrimSpace(code), now, user.LastTOTPStep)
	if !ok {
		return fail()
	}
	fresh, err := s.store.ConsumeTOTPStep(r.Context(), user.ID, step)
	if err != nil {
		return err
	}
	if !fresh {
		return fail()
	}
	if lockout {
		if err := s.store.ResetTOTPFailures(r.Context(), user.ID); err != nil {
			return err
		}
		user.TOTPFailures = store.TOTPFailures{}
	}
	user.LastTOTPStep = step
	return nil
}

func totpAAD(userID string) []byte { return []byte("journal/totp:" + userID) }

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(cookieName); err == nil && c.Value != "" && len(c.Value) <= 128 {
		if err := s.store.DeleteSession(r.Context(), auth.HashToken(c.Value)); err != nil {
			return err
		}
	}
	s.clearCookie(w)
	return ok(w)
}

// --- signup ---

type signupReq struct {
	Username          string          `json:"username"`
	Note              string          `json:"note"`
	KDF               *kdfJSON        `json:"kdf"`
	AuthKey           string          `json:"authKey"`
	RecoveryAuthKey   string          `json:"recoveryAuthKey"`
	WrappedMKPass     json.RawMessage `json:"wrappedMkPass"`
	WrappedMKRecovery json.RawMessage `json:"wrappedMkRecovery"`
	// Invite is an optional admin-minted code; it makes the account comped (SPEC §5.6).
	Invite string `json:"invite"`
}

const maxNoteLen = 500

var errInvalidInvite = errf(http.StatusBadRequest, "invalid_invite", "that invite code isn't valid, or it has already been used")

func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) error {
	var req signupReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if err := s.rateLimit(r, "signup", ""); err != nil {
		return err
	}
	username := normalizeUsername(req.Username)
	if !validUsername(username) {
		return errf(http.StatusBadRequest, "invalid_username", "username must be 3-32 characters of a-z, 0-9, '.', '_' or '-'")
	}
	note := strings.TrimSpace(req.Note)
	if len([]rune(note)) > maxNoteLen {
		return badRequest("note must be at most %d characters", maxNoteLen)
	}
	if !plainText(note) {
		// The note is shown in the admin page and `journal admin list`; control
		// characters could inject terminal escapes or reorder text there.
		return errf(http.StatusBadRequest, "invalid_note", "the note may not contain control characters")
	}
	invite := strings.TrimSpace(req.Invite)
	if invite != "" && (len(invite) > 64 || store.NormalizeInviteCode(invite) == "") {
		return errInvalidInvite
	}
	salt, err := req.KDF.validate()
	if err != nil {
		return err
	}
	authKey, err := key32("authKey", req.AuthKey)
	if err != nil {
		return err
	}
	recKey, err := key32("recoveryAuthKey", req.RecoveryAuthKey)
	if err != nil {
		return err
	}
	if bytes.Equal(authKey, recKey) {
		return badRequest("authKey and recoveryAuthKey must differ")
	}
	wrappedPass, err := wrappedKey("wrappedMkPass", req.WrappedMKPass)
	if err != nil {
		return err
	}
	wrappedRec, err := wrappedKey("wrappedMkRecovery", req.WrappedMKRecovery)
	if err != nil {
		return err
	}
	authHash, err := auth.HashSecret(r.Context(), authKey)
	if err != nil {
		return err
	}
	recHash, err := auth.HashSecret(r.Context(), recKey)
	if err != nil {
		return err
	}
	handle := make([]byte, 32)
	if _, err := rand.Read(handle); err != nil {
		return err
	}
	user := &store.User{
		ID:                uuid.New(),
		Username:          username,
		Note:              note,
		WebAuthnHandle:    handle,
		KDF:               store.KDF{Salt: salt, M: req.KDF.M, T: req.KDF.T, P: req.KDF.P},
		AuthHash:          authHash,
		RecoveryHash:      recHash,
		WrappedMKPass:     wrappedPass,
		WrappedMKRecovery: wrappedRec,
		CreatedAt:         s.cfg.Now(),
	}
	if invite != "" {
		err = s.store.CreateUserWithInvite(r.Context(), user, store.InviteCodeHash(invite))
	} else {
		err = s.store.CreateUser(r.Context(), user)
	}
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return errf(http.StatusConflict, "username_taken", "that username is taken")
		}
		if errors.Is(err, store.ErrInvalidInvite) {
			return errInvalidInvite
		}
		return err
	}
	if err := s.startSession(w, r, user.ID, store.SessionFull); err != nil {
		return err
	}
	if err := s.setDeviceCookie(w, r, user.ID); err != nil {
		return err
	}
	me, err := s.buildMe(r, user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"me": me})
}

// --- recovery ---

type recoverVerifyReq struct {
	Username        string `json:"username"`
	RecoveryAuthKey string `json:"recoveryAuthKey"`
	TOTPCode        string `json:"totpCode"`
}

func (s *Server) handleRecoverVerify(w http.ResponseWriter, r *http.Request) error {
	var req recoverVerifyReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	username, valid := loginUsername(req.Username)
	if err := s.rateLimit(r, "recover", username); err != nil {
		return err
	}
	recKey, err := key32("recoveryAuthKey", req.RecoveryAuthKey)
	if err != nil {
		return err
	}
	// The recovery key is 160 random bits, so only the per-IP limits apply to it.
	user, err := s.lookupUser(r, username, valid)
	if err != nil {
		return err
	}
	errBadRecovery := errf(http.StatusUnauthorized, "invalid_credentials", "username or recovery key is incorrect")
	if user == nil {
		if err := auth.BurnVerify(r.Context(), recKey); err != nil {
			return err
		}
		return errBadRecovery
	}
	if match, err := auth.VerifySecret(r.Context(), user.RecoveryHash, recKey); err != nil {
		return err
	} else if !match {
		return errBadRecovery
	}
	if user.Status == store.StatusDisabled {
		return errDisabled
	}
	if user.TOTPEnabled() {
		if strings.TrimSpace(req.TOTPCode) == "" {
			return errf(http.StatusUnauthorized, "totp_required", "a two-factor code is required")
		}
		// The recovery key already proved most of the identity: the escalating TOTP
		// lockout does not apply here (only the 5-per-10-minutes limit), so a locked
		// account's owner can still recover.
		if err := s.checkTOTP(r, user, req.TOTPCode, false); err != nil {
			return err
		}
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	if err := s.store.CreateRecoveryToken(r.Context(), hash, user.ID, now, now.Add(recoveryTTL)); err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{
		"token":             token,
		"wrappedMkRecovery": json.RawMessage(user.WrappedMKRecovery),
	})
}

type recoverResetReq struct {
	Token         string          `json:"token"`
	KDF           *kdfJSON        `json:"kdf"`
	AuthKey       string          `json:"authKey"`
	WrappedMKPass json.RawMessage `json:"wrappedMkPass"`
}

func (s *Server) handleRecoverReset(w http.ResponseWriter, r *http.Request) error {
	var req recoverResetReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if err := s.rateLimit(r, "recover-reset", ""); err != nil {
		return err
	}
	errBadToken := errf(http.StatusUnauthorized, "invalid_token", "recovery token is invalid or expired")
	if req.Token == "" || len(req.Token) > 128 {
		return errBadToken
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
	// Look the token up before hashing, so a request without a valid one costs no Argon2.
	// The token is only spent once the hash exists: a 503 busy leaves it usable for a retry.
	tokenHash := auth.HashToken(req.Token)
	if _, err := s.store.RecoveryTokenUser(r.Context(), tokenHash, s.cfg.Now()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errBadToken
		}
		return err
	}
	authHash, err := auth.HashSecret(r.Context(), authKey)
	if err != nil {
		return err
	}
	userID, err := s.store.ConsumeRecoveryToken(r.Context(), tokenHash, s.cfg.Now())
	if errors.Is(err, store.ErrNotFound) {
		return errBadToken
	}
	if err != nil {
		return err
	}
	user, err := s.store.UserByID(r.Context(), userID)
	if err != nil {
		return err
	}
	if user.Status == store.StatusDisabled {
		return errDisabled
	}
	kdf := store.KDF{Salt: salt, M: req.KDF.M, T: req.KDF.T, P: req.KDF.P}
	if err := s.store.UpdatePassphrase(r.Context(), user.ID, kdf, authHash, wrapped); err != nil {
		return err
	}
	// The old passphrase may be compromised: sign out everywhere.
	if err := s.store.DeleteUserSessions(r.Context(), user.ID, nil); err != nil {
		return err
	}
	user.KDF, user.AuthHash, user.WrappedMKPass = kdf, authHash, wrapped
	return s.completeLogin(w, r, user)
}

// --- passkey login (discoverable) ---

// challengeOwnerIP and challengeOwnerUser name who an outstanding WebAuthn challenge
// counts against (passkey.MaxPerOwner): the client address (IPv6 per /64, like the rate
// limits) for sign-ins begun without a session, the account for ceremonies begun with one.
func (s *Server) challengeOwnerIP(r *http.Request) string {
	return "ip|" + rateLimitKey(s.clientIP(r))
}

func challengeOwnerUser(userID string) string { return "user|" + userID }

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) error {
	if err := s.rateLimit(r, "passkey", ""); err != nil {
		return err
	}
	// A passkey sign-in replaces passphrase + TOTP, so it must be two factors in one:
	// possession of the authenticator plus user verification (PIN or biometric).
	options, data, err := s.wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return err
	}
	// Anyone can begin a sign-in, so these count against the caller's address.
	id, err := s.challenges.Put(passkey.KindLogin, "", s.challengeOwnerIP(r), *data)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"challengeId": id, "options": options})
}

type passkeyFinishReq struct {
	ChallengeID string          `json:"challengeId"`
	Name        string          `json:"name"`
	Credential  json.RawMessage `json:"credential"`
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) error {
	var req passkeyFinishReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if err := s.rateLimit(r, "passkey", ""); err != nil {
		return err
	}
	data, err := s.challenges.Take(req.ChallengeID, passkey.KindLogin, "")
	if err != nil {
		return errf(http.StatusBadRequest, "challenge_expired", "sign-in timed out, please try again")
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		return errf(http.StatusBadRequest, "webauthn_invalid", "malformed passkey response")
	}

	var (
		account *store.User
		stored  *store.Credential
	)
	lookup := func(rawID, userHandle []byte) (webauthn.User, error) {
		c, err := s.store.CredentialByCredentialID(r.Context(), rawID)
		if err != nil {
			return nil, err
		}
		u, err := s.store.UserByID(r.Context(), c.UserID)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(u.WebAuthnHandle, userHandle) {
			return nil, errors.New("user handle mismatch")
		}
		account, stored = u, c
		return &passkey.User{Account: u, Creds: []store.Credential{*c}}, nil
	}
	_, cred, err := s.wa.ValidatePasskeyLogin(lookup, data, parsed)
	if err != nil {
		return errf(http.StatusUnauthorized, "passkey_failed", "passkey sign-in failed")
	}
	if !cred.Flags.UserVerified {
		// The library already enforces this for VerificationRequired; kept explicit
		// because skipping it would make a bare security key a single factor.
		return errf(http.StatusUnauthorized, "passkey_failed", "this passkey did not verify you (PIN or biometric); sign in with your passphrase")
	}
	if cred.Authenticator.CloneWarning {
		s.log.Warn("passkey sign counter regression; possible cloned authenticator", "user", account.ID, "credential", stored.ID)
		return errf(http.StatusUnauthorized, "passkey_failed", "passkey sign-in failed")
	}
	if account.Status == store.StatusDisabled {
		return errDisabled
	}
	if err := s.store.RecordCredentialUse(r.Context(), stored.ID, cred.Authenticator.SignCount,
		byte(cred.Flags.ProtocolValue()), s.cfg.Now()); err != nil {
		return err
	}
	return s.completeLogin(w, r, account)
}
