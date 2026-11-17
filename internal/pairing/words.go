package pairing

import (
	"crypto/rand"
	_ "embed"
	"errors"
	"math/big"
	"strings"
)

// The phrase (ADR-0061) is six words from EFF's short wordlist 1 (1,296 words
// of at most five letters, picked to be easy to type and tell apart; by the
// Electronic Frontier Foundation, CC BY 3.0 US,
// https://www.eff.org/dice). The first word picks the sender's Bonjour
// advert, the other five are the CPace password: 5 × log2(1296) ≈ 51.7 bits,
// which a PAKE only lets an attacker guess online, three times.
//
//go:embed words.txt
var wordsTxt string

var (
	words     = strings.Fields(wordsTxt)
	wordIndex = func() map[string]int {
		m := make(map[string]int, len(words))
		for i, w := range words {
			m[w] = i
		}
		return m
	}()
)

// PhraseWords is how many words a phrase has.
const PhraseWords = 6

// ErrBadPhrase means the phrase isn't six words from the list.
var ErrBadPhrase = errors.New("pairing: that isn't a pairing phrase")

// Phrase is a parsed phrase: Tag finds the sender, Secret is the password.
type Phrase struct {
	Tag    int
	Secret string
}

// String is the phrase as shown: six words with spaces.
func (p Phrase) String() string { return words[p.Tag] + " " + p.Secret }

// NewPhrase draws a phrase at random.
func NewPhrase() (Phrase, error) {
	picked := make([]string, PhraseWords)
	idx := make([]int, PhraseWords)
	for i := range picked {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
		if err != nil {
			return Phrase{}, err
		}
		idx[i] = int(n.Int64())
		picked[i] = words[idx[i]]
	}
	return Phrase{Tag: idx[0], Secret: strings.Join(picked[1:], " ")}, nil
}

// ParsePhrase reads what the user typed: any case, any spacing, commas or
// full stops between words ("yo-yo" is one word).
func ParsePhrase(s string) (Phrase, error) {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return r == ' ' || r == ',' || r == '.' || r == '\t' || r == '\n'
	})
	if len(fields) != PhraseWords {
		return Phrase{}, ErrBadPhrase
	}
	for _, f := range fields {
		if _, ok := wordIndex[f]; !ok {
			return Phrase{}, ErrBadPhrase
		}
	}
	return Phrase{Tag: wordIndex[fields[0]], Secret: strings.Join(fields[1:], " ")}, nil
}
