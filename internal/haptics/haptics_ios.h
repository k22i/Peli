//go:build ios

#ifndef PELI_HAPTICS_IOS_H
#define PELI_HAPTICS_IOS_H

#define PELI_HAPTIC_LIGHT 0
#define PELI_HAPTIC_MEDIUM 1
#define PELI_HAPTIC_HEAVY 2
#define PELI_HAPTIC_SELECTION 3
#define PELI_HAPTIC_SUCCESS 4
#define PELI_HAPTIC_WARNING 5
#define PELI_HAPTIC_ERROR 6
// peli_haptic plays one tap of kind, on the main queue.
void peli_haptic(int kind);

#endif
