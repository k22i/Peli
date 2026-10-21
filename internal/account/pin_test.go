package account

import (
	"encoding/json"
	"testing"
)

func TestSwitchProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kevin := profileAt(t, f, 1)
	kids := profileAt(t, f, 3)

	// Kevin (index 1) isn't PIN-locked.
	if _, err := f.service.SwitchProfile(t.Context(), kevin.ID); err != nil {
		t.Fatal(err)
	}
	// Kids (index 3) is, until it's unlocked.
	_, err := f.service.SwitchProfile(t.Context(), kids.ID)
	if got := code(t, err); got != CodeProfileLocked {
		t.Fatalf("code = %q, want %q (err: %v)", got, CodeProfileLocked, err)
	}
}

func TestUnlockProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kevin := profileAt(t, f, 1)
	kids := profileAt(t, f, 3)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")

	err := f.service.UnlockProfile(t.Context(), kids.ID, "wrong")
	if got := code(t, err); got != CodeWrongPIN {
		t.Fatalf("wrong PIN: code = %q, want %q (err: %v)", got, CodeWrongPIN, err)
	}
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SwitchProfile(t.Context(), kids.ID); err != nil {
		t.Fatal(err)
	}
	if current, _ := f.store.CurrentProfile(); current.ID != kids.ID {
		t.Fatalf("current = %+v, want Kids", current)
	}
	// A profile without a PIN unlocks without a backend check.
	if err := f.service.UnlockProfile(t.Context(), kevin.ID, ""); err != nil {
		t.Fatal(err)
	}
}

func TestWrongPINRetry(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	f.backend.PinRetryAfter.Store(30)

	err := f.service.UnlockProfile(t.Context(), kids.ID, "wrong")
	if got := code(t, err); got != CodeWrongPIN {
		t.Fatalf("code = %q, want %q (err: %v)", got, CodeWrongPIN, err)
	}
	var cause struct{ RetryAfterSeconds int }
	if err := json.Unmarshal(MarshalError(err), &cause); err != nil {
		t.Fatal(err)
	}
	if cause.RetryAfterSeconds != 30 {
		t.Fatalf("retryAfterSeconds = %d, want 30", cause.RetryAfterSeconds)
	}
}

func TestEditLockedProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")

	_, err := f.service.EditProfile(t.Context(), kids.ID, ProfileEdit{Name: "X"})
	if got := code(t, err); got != CodeProfileLocked {
		t.Fatalf("code = %q, want %q (err: %v)", got, CodeProfileLocked, err)
	}
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.EditProfile(t.Context(), kids.ID, ProfileEdit{Name: "X"}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteLockedProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	err := f.service.DeleteProfile(t.Context(), kids.ID)
	if got := code(t, err); got != CodeProfileLocked {
		t.Fatalf("code = %q, want %q (err: %v)", got, CodeProfileLocked, err)
	}
}

func TestProfileLocksStored(t *testing.T) {
	f, _, _ := signedIn(t)
	if !profileAt(t, f, 3).PinEnabled {
		t.Fatal("Kids isn't PIN-locked")
	}
	if profileAt(t, f, 1).PinEnabled {
		t.Fatal("Kevin is PIN-locked")
	}
}

func TestSetProfilePIN(t *testing.T) {
	f, _, _ := signedIn(t)
	kevin := profileAt(t, f, 1)

	// A first PIN, on a profile that isn't locked.
	if err := f.service.SetProfilePIN(t.Context(), kevin.ID, "1234", ""); err != nil {
		t.Fatal(err)
	}
	if !profileAt(t, f, 1).PinEnabled {
		t.Fatal("Kevin isn't PIN-locked after SetProfilePIN")
	}

	// A wrong current PIN to change it.
	err := f.service.SetProfilePIN(t.Context(), kevin.ID, "5678", "wrong")
	if got := code(t, err); got != CodeWrongPIN {
		t.Fatalf("wrong PIN: code = %q, want %q (err: %v)", got, CodeWrongPIN, err)
	}
	// The right current PIN changes it.
	if err := f.service.SetProfilePIN(t.Context(), kevin.ID, "5678", "1234"); err != nil {
		t.Fatal(err)
	}
	if err := f.service.UnlockProfile(t.Context(), kevin.ID, "5678"); err != nil {
		t.Fatal(err)
	}

	// A non-4-digit PIN is refused.
	err = f.service.SetProfilePIN(t.Context(), kevin.ID, "12", "")
	if got := code(t, err); got != CodeInvalidPIN {
		t.Fatalf("short PIN: code = %q, want %q (err: %v)", got, CodeInvalidPIN, err)
	}
}

func TestClearProfilePIN(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	// Kids is already PIN-locked; unlock it before clearing.
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}

	err := f.service.ClearProfilePIN(t.Context(), kids.ID, "wrong")
	if got := code(t, err); got != CodeWrongPIN {
		t.Fatalf("wrong PIN: code = %q, want %q (err: %v)", got, CodeWrongPIN, err)
	}
	if err := f.service.ClearProfilePIN(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if profileAt(t, f, 3).PinEnabled {
		t.Fatal("Kids is still PIN-locked after ClearProfilePIN")
	}
}

func TestSetProfilePINLocked(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	err := f.service.SetProfilePIN(t.Context(), kids.ID, "9999", "")
	if got := code(t, err); got != CodeProfileLocked {
		t.Fatalf("code = %q, want %q (err: %v)", got, CodeProfileLocked, err)
	}
}
