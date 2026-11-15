package uuid

import "testing"

func TestNew(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := New()
		got, version, ok := Parse(id)
		if !ok || got != id || version != 4 {
			t.Fatalf("New() = %q: parse (%q, %d, %v)", id, got, version, ok)
		}
		if c := id[19]; c != '8' && c != '9' && c != 'a' && c != 'b' {
			t.Fatalf("New() = %q: not the RFC 4122 variant", id)
		}
		if seen[id] {
			t.Fatalf("New() repeated %q", id)
		}
		seen[id] = true
	}
}

func TestParse(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		version int
		ok      bool
	}{
		{"canonical v4", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b", 4, true},
		{"upper case is folded", "9B2F8C1E-7A4D-4E3B-8F6A-0C1D2E3F4A5B", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b", 4, true},
		{"v1", "9b2f8c1e-7a4d-1e3b-8f6a-0c1d2e3f4a5b", "9b2f8c1e-7a4d-1e3b-8f6a-0c1d2e3f4a5b", 1, true},
		{"empty", "", "", 0, false},
		{"no dashes", "9b2f8c1e7a4d4e3b8f6a0c1d2e3f4a5b", "", 0, false},
		{"braces", "{9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b}", "", 0, false},
		{"urn", "urn:uuid:9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b", "", 0, false},
		{"non-hex", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5g", "", 0, false},
		{"dash in the wrong place", "9b2f8c1e7-a4d-4e3b-8f6a-0c1d2e3f4a5b", "", 0, false},
		{"hex where a dash belongs", "9b2f8c1e07a4d-4e3b-8f6a-0c1d2e3f4a5b", "", 0, false},
		{"too long", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5b0", "", 0, false},
		{"trailing newline", "9b2f8c1e-7a4d-4e3b-8f6a-0c1d2e3f4a5\n", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, version, ok := Parse(tc.in)
			if got != tc.want || version != tc.version || ok != tc.ok {
				t.Fatalf("Parse(%q) = (%q, %d, %v), want (%q, %d, %v)", tc.in, got, version, ok, tc.want, tc.version, tc.ok)
			}
		})
	}
}
