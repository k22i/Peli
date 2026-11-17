//go:build ios

#import <UIKit/UIKit.h>
#include "haptics_ios.h"

void peli_haptic(int kind) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (kind == PELI_HAPTIC_SELECTION) {
			[[UISelectionFeedbackGenerator new] selectionChanged];
			return;
		}
		UIImpactFeedbackStyle style = UIImpactFeedbackStyleLight;
		if (kind == PELI_HAPTIC_MEDIUM) style = UIImpactFeedbackStyleMedium;
		if (kind == PELI_HAPTIC_HEAVY) style = UIImpactFeedbackStyleHeavy;
		[[[UIImpactFeedbackGenerator alloc] initWithStyle:style] impactOccurred];
	});
}
