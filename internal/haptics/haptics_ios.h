//go:build ios

#ifndef PELI_HAPTICS_IOS_H
#define PELI_HAPTICS_IOS_H

#define PELI_HAPTIC_LIGHT 0
#define PELI_HAPTIC_MEDIUM 1
#define PELI_HAPTIC_HEAVY 2
#define PELI_HAPTIC_SELECTION 3
// peli_haptic plays one tap of kind, on the main queue.
void peli_haptic(int kind);

#endif
