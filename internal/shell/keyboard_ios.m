//go:build ios

// Hardware keyboard detection (#138): an iPad with a Magic Keyboard (or any
// Bluetooth keyboard) gets Peli's desktop shortcuts, the command palette and
// the shortcuts overlay; they go away again when it detaches. WebKit doesn't
// say whether a keyboard is there, so GameController does.
#import <Foundation/Foundation.h>
#import <GameController/GameController.h>

#include "tabbar_ios.h"

static BOOL attachedNow(void) { return GCKeyboard.coalescedKeyboard != nil; }

int peli_keyboard_watch(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
		// coalescedKeyboard is already set (or cleared) when these arrive;
		// both say the state anew, so a missed one is put right by the next.
		[nc addObserverForName:GCKeyboardDidConnectNotification object:nil queue:nil
		            usingBlock:^(NSNotification *n) { peliShellKeyboard(1); }];
		[nc addObserverForName:GCKeyboardDidDisconnectNotification object:nil queue:nil
		            usingBlock:^(NSNotification *n) { peliShellKeyboard(attachedNow() ? 1 : 0); }];
	});
	return attachedNow() ? 1 : 0;
}
