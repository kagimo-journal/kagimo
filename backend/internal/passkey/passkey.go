// Package passkey wraps go-webauthn: relying-party configuration, in-memory
// single-use ceremony challenges, and conversion between stored credentials and
// library types.
package passkey

import (
	"container/list"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"journal/internal/store"
)

// ChallengeTTL is how long a ceremony challenge stays valid (SPEC §6).
const ChallengeTTL = 5 * time.Minute

// maxChallenges bounds memory used by outstanding ceremonies. When the pool is full the
// oldest challenge makes way for a new one: refusing instead would let anyone who can
// fill the pool (it takes no credentials to begin a sign-in) keep everybody else out.
const maxChallenges = 10_000

// MaxPerOwner is how many ceremonies one owner (a client address for sign-ins without a
// session, an account for the rest) may have outstanding. Beginning another drops that
// owner's oldest, so one client cannot crowd out the others' challenges. A real client
// has one ceremony under way, or a few after cancelled prompts.
const MaxPerOwner = 8

// Ceremony kinds.
const (
	KindRegister = "register"
	KindLogin    = "login"
	// KindMFA is a passkey assertion completing a passphrase sign-in (bound to the user).
	KindMFA = "mfa"
)

// ErrChallengeUnknown is returned for a challenge that does not exist (any more), has
// expired, or belongs to another kind of ceremony or another user.
var ErrChallengeUnknown = errors.New("passkey: unknown or expired challenge")

// New builds the WebAuthn relying party.
func New(rpID, rpName, origin string) (*webauthn.WebAuthn, error) {
	requireRK := true
	return webauthn.New(&webauthn.Config{
		RPID:                  rpID,
		RPDisplayName:         rpName,
		RPOrigins:             []string{origin},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			RequireResidentKey: &requireRK,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationPreferred,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: ChallengeTTL},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: ChallengeTTL},
		},
	})
}

// pending is one outstanding ceremony.
type pending struct {
	id      string
	kind    string
	userID  string // owning account for registration; empty for discoverable login
	owner   string // whose allowance (MaxPerOwner) it counts against
	data    webauthn.SessionData
	expires time.Time
}

// Challenges is an in-memory, single-use store of ceremony session data.
type Challenges struct {
	mu    sync.Mutex
	items map[string]*list.Element // id → element of order
	// order holds every pending ceremony, oldest first. All challenges live equally long,
	// so this is also the order they expire in.
	order   *list.List
	byOwner map[string][]string // owner → ids, oldest first
	now     func() time.Time
	max     int
}

// NewChallenges creates an empty store.
func NewChallenges(now func() time.Time) *Challenges {
	if now == nil {
		now = time.Now
	}
	return &Challenges{items: make(map[string]*list.Element), order: list.New(), byOwner: make(map[string][]string), now: now, max: maxChallenges}
}

// Put stores session data and returns a random challenge id. owner names who the ceremony
// counts against: at most MaxPerOwner are kept per owner, and at most maxChallenges in
// all; past either, the oldest (the owner's, or anyone's) is dropped to make room.
func (c *Challenges) Put(kind, userID, owner string, data webauthn.SessionData) (string, error) {
	raw := make([]byte, 18)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if ids := c.byOwner[owner]; len(ids) >= MaxPerOwner {
		c.removeLocked(ids[0])
	}
	if len(c.items) >= c.max {
		c.pruneLocked(now)
		if len(c.items) >= c.max {
			c.removeLocked(c.order.Front().Value.(*pending).id)
		}
	}
	c.items[id] = c.order.PushBack(&pending{id: id, kind: kind, userID: userID, owner: owner, data: data, expires: now.Add(ChallengeTTL)})
	c.byOwner[owner] = append(c.byOwner[owner], id)
	return id, nil
}

// Take removes and returns the session data for id if it exists, has not
// expired, and matches kind and userID. A challenge can be taken only once.
func (c *Challenges) Take(id, kind, userID string) (webauthn.SessionData, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[id]
	if !ok {
		return webauthn.SessionData{}, ErrChallengeUnknown
	}
	p := el.Value.(*pending)
	c.removeLocked(id)
	if p.kind != kind || p.userID != userID || !c.now().Before(p.expires) {
		return webauthn.SessionData{}, ErrChallengeUnknown
	}
	return p.data, nil
}

// Prune drops expired challenges.
func (c *Challenges) Prune() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked(c.now())
}

// Len returns the number of outstanding challenges.
func (c *Challenges) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

// pruneLocked drops expired challenges: they are at the front of order.
func (c *Challenges) pruneLocked(now time.Time) {
	for el := c.order.Front(); el != nil; el = c.order.Front() {
		p := el.Value.(*pending)
		if now.Before(p.expires) {
			return
		}
		c.removeLocked(p.id)
	}
}

// removeLocked forgets one challenge.
func (c *Challenges) removeLocked(id string) {
	el, ok := c.items[id]
	if !ok {
		return
	}
	p := c.order.Remove(el).(*pending)
	delete(c.items, id)
	ids := c.byOwner[p.owner]
	for i, v := range ids {
		if v == id {
			ids = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	if len(ids) == 0 {
		delete(c.byOwner, p.owner)
	} else {
		c.byOwner[p.owner] = ids
	}
}

// User adapts a stored user and their credentials to webauthn.User.
type User struct {
	Account *store.User
	Creds   []store.Credential
}

// WebAuthnID implements webauthn.User.
func (u *User) WebAuthnID() []byte { return u.Account.WebAuthnHandle }

// WebAuthnName implements webauthn.User.
func (u *User) WebAuthnName() string { return u.Account.Username }

// WebAuthnDisplayName implements webauthn.User.
func (u *User) WebAuthnDisplayName() string { return u.Account.Username }

// WebAuthnCredentials implements webauthn.User.
func (u *User) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, 0, len(u.Creds))
	for i := range u.Creds {
		out = append(out, ToLibrary(&u.Creds[i]))
	}
	return out
}

// Descriptors returns credential descriptors (used to exclude existing credentials on registration).
func (u *User) Descriptors() []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(u.Creds))
	for _, c := range u.WebAuthnCredentials() {
		out = append(out, c.Descriptor())
	}
	return out
}

// ToLibrary converts a stored credential to the library type.
func ToLibrary(c *store.Credential) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, 0, len(c.Transports))
	for _, t := range c.Transports {
		transports = append(transports, protocol.AuthenticatorTransport(t))
	}
	return webauthn.Credential{
		ID:                c.CredentialID,
		PublicKey:         c.PublicKey,
		AttestationType:   c.AttestationType,
		AttestationFormat: c.AttestationFormat,
		Transport:         transports,
		Flags:             webauthn.NewCredentialFlags(protocol.AuthenticatorFlags(c.Flags)),
		Authenticator: webauthn.Authenticator{
			AAGUID:    c.AAGUID,
			SignCount: c.SignCount,
		},
	}
}

// FromLibrary converts a freshly registered library credential into a store row
// (ID, UserID, Name and CreatedAt are filled in by the caller).
func FromLibrary(c *webauthn.Credential) store.Credential {
	transports := make([]string, 0, len(c.Transport))
	for _, t := range c.Transport {
		transports = append(transports, string(t))
	}
	return store.Credential{
		CredentialID:      c.ID,
		PublicKey:         c.PublicKey,
		SignCount:         c.Authenticator.SignCount,
		Transports:        transports,
		AAGUID:            c.Authenticator.AAGUID,
		Flags:             byte(c.Flags.ProtocolValue()),
		AttestationType:   c.AttestationType,
		AttestationFormat: c.AttestationFormat,
	}
}
