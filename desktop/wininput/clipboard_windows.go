package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

const cfHDrop = 15

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	clipboardOpen        = user32.NewProc("OpenClipboard")
	clipboardClose       = user32.NewProc("CloseClipboard")
	clipboardEmpty       = user32.NewProc("EmptyClipboard")
	clipboardData        = user32.NewProc("GetClipboardData")
	clipboardSetData     = user32.NewProc("SetClipboardData")
	clipboardSequence    = user32.NewProc("GetClipboardSequenceNumber")
	clipboardForeground  = user32.NewProc("GetForegroundWindow")
	clipboardCreateOwner = user32.NewProc("CreateWindowExW")
	clipboardDestroy     = user32.NewProc("DestroyWindow")
	clipboardDropEffect  = user32.NewProc("RegisterClipboardFormatW")
	clipboardQueryFile   = shell32.NewProc("DragQueryFileW")
	clipboardAlloc       = kernel32.NewProc("GlobalAlloc")
	clipboardLock        = kernel32.NewProc("GlobalLock")
	clipboardUnlock      = kernel32.NewProc("GlobalUnlock")
	clipboardFree        = kernel32.NewProc("GlobalFree")
)

func openClipboard(owner uintptr) error {
	for attempt := 0; attempt < 10; attempt++ {
		if result, _, _ := clipboardOpen.Call(owner); result != 0 {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("clipboard busy")
}

func readClipboardFiles() ([]string, error) {
	if err := openClipboard(0); err != nil {
		return nil, err
	}
	defer clipboardClose.Call()
	files := []string{}
	drop, _, _ := clipboardData.Call(cfHDrop)
	if drop == 0 {
		return files, nil
	}
	count, _, _ := clipboardQueryFile.Call(drop, 0xffffffff, 0, 0)
	if count > 512 {
		return nil, fmt.Errorf("too many clipboard entries")
	}
	for index := uintptr(0); index < count; index++ {
		length, _, _ := clipboardQueryFile.Call(drop, index, 0, 0)
		if length == 0 {
			continue
		}
		buffer := make([]uint16, length+1)
		if copied, _, _ := clipboardQueryFile.Call(drop, index, uintptr(unsafe.Pointer(&buffer[0])), length+1); copied == length {
			files = append(files, syscall.UTF16ToString(buffer))
		}
	}
	return files, nil
}

func clipboardMemory(data []byte) (uintptr, error) {
	handle, _, err := clipboardAlloc.Call(0x0002, uintptr(len(data))) // GMEM_MOVEABLE
	if handle == 0 {
		return 0, err
	}
	ptr, _, err := clipboardLock.Call(handle)
	if ptr == 0 {
		clipboardFree.Call(handle)
		return 0, err
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data)), data)
	clipboardUnlock.Call(handle)
	return handle, nil
}

func writeClipboardFiles(files []string) error {
	if len(files) == 0 || len(files) > 512 {
		return fmt.Errorf("invalid clipboard entries")
	}
	data := make([]byte, 20)
	binary.LittleEndian.PutUint32(data, 20)     // DROPFILES.pFiles
	binary.LittleEndian.PutUint32(data[16:], 1) // DROPFILES.fWide
	for _, file := range files {
		path, err := syscall.UTF16FromString(file)
		if err != nil {
			return err
		}
		for _, word := range path {
			data = binary.LittleEndian.AppendUint16(data, word)
		}
	}
	data = binary.LittleEndian.AppendUint16(data, 0)
	handle, err := clipboardMemory(data)
	if err != nil {
		return err
	}
	defer func() {
		if handle != 0 {
			clipboardFree.Call(handle)
		}
	}()
	ownerClass, _ := syscall.UTF16PtrFromString("STATIC")
	owner, _, err := clipboardCreateOwner.Call(0, uintptr(unsafe.Pointer(ownerClass)), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	if owner == 0 {
		return err
	}
	defer clipboardDestroy.Call(owner)
	if err := openClipboard(owner); err != nil {
		return err
	}
	defer clipboardClose.Call()
	if result, _, err := clipboardEmpty.Call(); result == 0 {
		return err
	}
	if result, _, err := clipboardSetData.Call(cfHDrop, handle); result == 0 {
		return err
	}
	handle = 0 // Windows owns the memory after SetClipboardData succeeds.
	formatName, _ := syscall.UTF16PtrFromString("Preferred DropEffect")
	format, _, _ := clipboardDropEffect.Call(uintptr(unsafe.Pointer(formatName)))
	if format != 0 {
		if effect, err := clipboardMemory([]byte{1, 0, 0, 0}); err == nil {
			if result, _, _ := clipboardSetData.Call(format, effect); result == 0 {
				clipboardFree.Call(effect)
			}
		}
	}
	return nil
}

func runClipboard(command string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	switch command {
	case "--clipboard-state":
		sequence, _, _ := clipboardSequence.Call()
		foreground, _, _ := clipboardForeground.Call()
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"sequence": uint32(sequence), "foreground": strconv.FormatUint(uint64(foreground), 10)})
	case "--clipboard-read":
		files, err := readClipboardFiles()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(files)
	case "--clipboard-write":
		var files []string
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 4*1024*1024)).Decode(&files); err != nil {
			return err
		}
		return writeClipboardFiles(files)
	}
	return fmt.Errorf("invalid clipboard command")
}
