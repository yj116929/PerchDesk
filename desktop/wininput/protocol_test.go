package main

import "testing"

func TestPhysicalDisplayCorners(t *testing.T) {
	bounds := rect{-1920, -1080, 1920, 1080}
	for _, test := range []struct {
		x, y         float64
		wantX, wantY int32
		ok           bool
	}{
		{0, 0, -1920, -1080, true},
		{1, 1, -1, -1, true},
		{0.5, 0.5, -960, -540, true},
		{1.01, 0, 0, 0, false},
	} {
		x, y, ok := bounds.point(test.x, test.y)
		if x != test.wantX || y != test.wantY || ok != test.ok {
			t.Errorf("point(%v, %v) = (%v, %v, %v)", test.x, test.y, x, y, ok)
		}
	}
}

func TestExtendedKeyAndWheel(t *testing.T) {
	for _, code := range []string{"ArrowLeft", "ControlRight", "MetaLeft", "NumpadEnter"} {
		if scanCodes[code]>>8 != 0xE0 {
			t.Errorf("%v should use an extended scan code", code)
		}
	}
	if wheelDelta(-2500) != -1000 || wheelDelta(45.9) != 46 {
		t.Error("wheel must round and limit deltas")
	}
}
