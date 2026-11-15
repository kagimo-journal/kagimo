package api

import (
	"errors"
	"net/http"
	"strings"

	"journal/internal/store"
	"journal/internal/uuid"
)

// Invite codes (SPEC §5.6): an admin mints as many as they like; each one, entered at sign-up,
// gives that new account free access. Only a hash is stored, so the code is returned once.

const maxInviteNoteLen = 200

type inviteJSON struct {
	ID        string  `json:"id"`
	Note      string  `json:"note"`
	CreatedAt string  `json:"createdAt"`
	UsedAt    *string `json:"usedAt"`
	UsedBy    string  `json:"usedBy"`
	// Code is only present in the response that created the invite.
	Code string `json:"code,omitempty"`
}

func toInviteJSON(inv *store.Invite) inviteJSON {
	return inviteJSON{ID: inv.ID, Note: inv.Note, CreatedAt: ts(inv.CreatedAt), UsedAt: tsPtr(inv.UsedAt), UsedBy: inv.UsedBy}
}

func (s *Server) handleAdminListInvites(w http.ResponseWriter, r *http.Request) error {
	invites, err := s.store.ListInvites(r.Context())
	if err != nil {
		return err
	}
	out := make([]inviteJSON, 0, len(invites))
	for i := range invites {
		out = append(out, toInviteJSON(&invites[i]))
	}
	return writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAdminCreateInvite(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Note string `json:"note"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	note := strings.TrimSpace(req.Note)
	if len([]rune(note)) > maxInviteNoteLen {
		return badRequest("note must be at most %d characters", maxInviteNoteLen)
	}
	if !plainText(note) {
		return errf(http.StatusBadRequest, "invalid_note", "the note may not contain control characters")
	}
	code, err := store.NewInviteCode()
	if err != nil {
		return err
	}
	inv := &store.Invite{ID: uuid.New(), Note: note, CreatedBy: caller(r).user.ID, CreatedAt: s.cfg.Now()}
	if err := s.store.CreateInvite(r.Context(), inv, code); err != nil {
		return err
	}
	out := toInviteJSON(inv)
	out.Code = code
	return writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAdminDeleteInvite(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	switch err := s.store.DeleteInvite(r.Context(), id); {
	case errors.Is(err, store.ErrNotFound):
		return errNotFound
	case errors.Is(err, store.ErrConflict):
		return errf(http.StatusConflict, "invite_used", "that invite has already been used")
	case err != nil:
		return err
	}
	return ok(w)
}
