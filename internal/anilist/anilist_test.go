package anilist

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExpiry(t *testing.T) {
	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"aud":"1","exp":1830000000.5,"sub":"7"}`))
	if got := Expiry("h." + claims + ".s"); !got.Equal(time.Unix(1830000000, 0)) {
		t.Fatalf("Expiry = %v", got)
	}
	if !Expiry("not a jwt").IsZero() {
		t.Fatal("a token that isn't a JWT has an expiry")
	}
}

func TestErrors(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		check  func(error) bool
	}{
		{400, `{"data":null,"errors":[{"message":"Invalid token","status":400}]}`, func(err error) bool { return errors.Is(err, ErrUnauthorized) }},
		{429, `{"data":null,"errors":[{"message":"Too Many Requests.","status":429}]}`, func(err error) bool {
			var limited *RateLimited
			return errors.As(err, &limited) && limited.RetryAfter == time.Minute && Temporary(err)
		}},
		{500, ``, func(err error) bool { return errors.Is(err, ErrUnavailable) }},
		{200, `{"data":{"Media":null},"errors":[{"message":"Not Found.","status":404}]}`, func(err error) bool { return errors.Is(err, ErrNotFound) }},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		_, err := New(srv.URL, "1.0").WithEntry(context.Background(), "token", 1)
		srv.Close()
		if !tc.check(err) {
			t.Errorf("HTTP %d %s: err = %v", tc.status, tc.body, err)
		}
	}
}

func TestAuthorizeURL(t *testing.T) {
	if got := AuthorizeURL("123"); got != "https://anilist.co/api/v2/oauth/authorize?client_id=123&response_type=token" {
		t.Fatal(got)
	}
}
