package main

import "math"

type event struct {
	Type    string  `json:"type"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	DX      float64 `json:"dx"`
	DY      float64 `json:"dy"`
	Code    string  `json:"code"`
	Down    bool    `json:"down"`
	Btn     int     `json:"button"`
	Receipt uint64  `json:"receipt,omitempty"`
}

type rect struct {
	x, y, width, height int32
}

func (r rect) point(x, y float64) (int32, int32, bool) {
	if !(x >= 0 && x <= 1 && y >= 0 && y <= 1) || r.width < 1 || r.height < 1 {
		return 0, 0, false
	}
	return r.x + int32(math.Round(x*float64(r.width-1))),
		r.y + int32(math.Round(y*float64(r.height-1))), true
}

var scanCodes = map[string]uint16{
	"KeyA": 0x1E, "KeyB": 0x30, "KeyC": 0x2E, "KeyD": 0x20, "KeyE": 0x12, "KeyF": 0x21,
	"KeyG": 0x22, "KeyH": 0x23, "KeyI": 0x17, "KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26,
	"KeyM": 0x32, "KeyN": 0x31, "KeyO": 0x18, "KeyP": 0x19, "KeyQ": 0x10, "KeyR": 0x13,
	"KeyS": 0x1F, "KeyT": 0x14, "KeyU": 0x16, "KeyV": 0x2F, "KeyW": 0x11, "KeyX": 0x2D,
	"KeyY": 0x15, "KeyZ": 0x2C, "Digit0": 0x0B, "Digit1": 0x02, "Digit2": 0x03, "Digit3": 0x04,
	"Digit4": 0x05, "Digit5": 0x06, "Digit6": 0x07, "Digit7": 0x08, "Digit8": 0x09, "Digit9": 0x0A,
	"Enter": 0x1C, "Escape": 0x01, "Backspace": 0x0E, "Tab": 0x0F, "Space": 0x39, "Minus": 0x0C,
	"Equal": 0x0D, "BracketLeft": 0x1A, "BracketRight": 0x1B, "Backslash": 0x2B,
	"Semicolon": 0x27, "Quote": 0x28, "Backquote": 0x29, "Comma": 0x33, "Period": 0x34, "Slash": 0x35,
	"ShiftLeft": 0x2A, "ShiftRight": 0x36, "ControlLeft": 0x1D, "ControlRight": 0xE01D,
	"AltLeft": 0x38, "AltRight": 0xE038, "MetaLeft": 0xE05B, "MetaRight": 0xE05C, "CapsLock": 0x3A,
	"F1": 0x3B, "F2": 0x3C, "F3": 0x3D, "F4": 0x3E, "F5": 0x3F, "F6": 0x40, "F7": 0x41,
	"F8": 0x42, "F9": 0x43, "F10": 0x44, "F11": 0x57, "F12": 0x58,
	"Insert": 0xE052, "Delete": 0xE053, "Home": 0xE047, "End": 0xE04F, "PageUp": 0xE049,
	"PageDown": 0xE051, "ArrowUp": 0xE048, "ArrowDown": 0xE050, "ArrowLeft": 0xE04B, "ArrowRight": 0xE04D,
	"Numpad0": 0x52, "Numpad1": 0x4F, "Numpad2": 0x50, "Numpad3": 0x51, "Numpad4": 0x4B,
	"Numpad5": 0x4C, "Numpad6": 0x4D, "Numpad7": 0x47, "Numpad8": 0x48, "Numpad9": 0x49,
	"NumpadEnter": 0xE01C, "NumpadDecimal": 0x53, "NumpadAdd": 0x4E, "NumpadSubtract": 0x4A,
	"NumpadMultiply": 0x37, "NumpadDivide": 0xE035,
}

func wheelDelta(value float64) int32 {
	return int32(math.Round(math.Max(-1000, math.Min(1000, value))))
}
