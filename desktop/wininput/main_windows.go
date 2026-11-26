package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	user32    = syscall.NewLazyDLL("user32.dll")
	sendInput = user32.NewProc("SendInput")
	setCursor = user32.NewProc("SetPhysicalCursorPos")
)

type input struct {
	kind uint32
	_    uint32
	data [4]uint64
}

type keyboard struct {
	virtualKey, scan uint16
	flags, time      uint32
	extraInfo        uintptr
}

type mouse struct {
	x, y               int32
	wheel, flags, time uint32
	extraInfo          uintptr
}

type remote struct {
	bounds  rect
	pressed map[uint16]bool
	buttons [3]bool
}

func post(event *input) bool {
	sent, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(event)), unsafe.Sizeof(*event))
	runtime.KeepAlive(event)
	return sent == 1
}

func writeKey(code uint16, down bool) bool {
	flags := uint32(0x0008) // KEYEVENTF_SCANCODE
	if code > 0xFF {
		flags |= 0x0001 // KEYEVENTF_EXTENDEDKEY
	}
	if !down {
		flags |= 0x0002 // KEYEVENTF_KEYUP
	}
	event := input{kind: 1}
	*(*keyboard)(unsafe.Pointer(&event.data)) = keyboard{scan: code & 0xFF, flags: flags}
	return post(&event)
}

func writeMouse(flags uint32, wheel int32) bool {
	event := input{}
	*(*mouse)(unsafe.Pointer(&event.data)) = mouse{flags: flags, wheel: uint32(wheel)}
	return post(&event)
}

var buttonDown = [3]uint32{0x0002, 0x0020, 0x0008}
var buttonUp = [3]uint32{0x0004, 0x0040, 0x0010}

func (r *remote) reset() {
	for i, down := range r.buttons {
		if down {
			writeMouse(buttonUp[i], 0)
			r.buttons[i] = false
		}
	}
	for key := range r.pressed {
		writeKey(key, false)
		delete(r.pressed, key)
	}
}

func (r *remote) apply(e event) {
	switch e.Type {
	case "reset":
		r.reset()
	case "key":
		if code, ok := scanCodes[e.Code]; ok && (e.Down || r.pressed[code]) && writeKey(code, e.Down) {
			if e.Down {
				r.pressed[code] = true
			} else {
				delete(r.pressed, code)
			}
		}
	case "move", "button", "wheel":
		x, y, valid := r.bounds.point(e.X, e.Y)
		if !valid {
			return
		}
		moved, _, _ := setCursor.Call(uintptr(x), uintptr(y))
		if moved == 0 {
			return
		}
		if e.Type == "button" && e.Btn >= 0 && e.Btn < len(r.buttons) && r.buttons[e.Btn] != e.Down {
			flags := buttonUp[e.Btn]
			if e.Down {
				flags = buttonDown[e.Btn]
			}
			if writeMouse(flags, 0) {
				r.buttons[e.Btn] = e.Down
			}
		} else if e.Type == "wheel" {
			if dy := wheelDelta(e.DY); dy != 0 {
				writeMouse(0x0800, -dy) // MOUSEEVENTF_WHEEL
			}
			if dx := wheelDelta(e.DX); dx != 0 {
				writeMouse(0x1000, dx) // MOUSEEVENTF_HWHEEL
			}
		}
	}
}

func run(args []string) error {
	if len(args) != 4 || unsafe.Sizeof(input{}) != 40 {
		return fmt.Errorf("invalid display or input layout")
	}
	var dimensions [4]int32
	for i, arg := range args {
		value, err := strconv.ParseInt(arg, 10, 32)
		if err != nil {
			return err
		}
		dimensions[i] = int32(value)
	}
	r := remote{bounds: rect{dimensions[0], dimensions[1], dimensions[2], dimensions[3]}, pressed: make(map[uint16]bool)}
	if _, _, valid := r.bounds.point(0, 0); !valid {
		return fmt.Errorf("invalid display size")
	}
	if err := sendInput.Find(); err != nil {
		return err
	}
	if err := setCursor.Find(); err != nil {
		return err
	}
	defer r.reset()
	if _, err := fmt.Fprintln(os.Stdout, "ready"); err != nil {
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 2048), 2048)
	for scanner.Scan() {
		var message event
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			return err
		}
		r.apply(message)
		if message.Receipt > 0 {
			if _, err := fmt.Fprintf(os.Stdout, "ack %d\n", message.Receipt); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--capture" {
		if err := runCapture(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && (os.Args[1] == "--clipboard-state" || os.Args[1] == "--clipboard-read" || os.Args[1] == "--clipboard-write") {
		if err := runClipboard(os.Args[1]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--lock" {
		lock := user32.NewProc("LockWorkStation")
		if result, _, err := lock.Call(); result == 0 {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
