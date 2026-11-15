//go:build unix

package main

import "syscall"

// restrictUmask makes every file the process creates (journal.db and its -wal/-shm
// files, which SQLite re-creates over time) private to the service user.
func restrictUmask() { syscall.Umask(0o077) }
