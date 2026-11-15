// Package uuid generates and validates the uuid v4 ids used for users, passkeys,
// invites and client-generated content.
package uuid

import "crypto/rand"

const hexDigits = "0123456789abcdef"

// New returns a random (version 4) uuid in canonical lowercase form.
func New() string {
	var b [16]byte
	rand.Read(b[:])         // never fails: crypto/rand aborts the program if the OS source does
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	out := make([]byte, 0, 36)
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hexDigits[v>>4], hexDigits[v&0x0f])
	}
	return string(out)
}

// Parse validates the 36-character form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (hex digits
// in either case) and returns it in canonical lowercase form with its version. Nothing
// else is accepted: no braces, no urn:uuid: prefix, no undashed form.
func Parse(s string) (canonical string, version int, ok bool) {
	if len(s) != 36 {
		return "", 0, false
	}
	out := make([]byte, 36)
	for i := 0; i < 36; i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return "", 0, false
			}
		} else {
			switch {
			case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
			case c >= 'A' && c <= 'F':
				c += 'a' - 'A'
			default:
				return "", 0, false
			}
		}
		out[i] = c
	}
	v := out[14]
	if v >= 'a' {
		version = int(v-'a') + 10
	} else {
		version = int(v - '0')
	}
	return string(out), version, true
}
