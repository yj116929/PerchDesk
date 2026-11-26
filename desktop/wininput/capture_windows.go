package main

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	winrt                  = syscall.NewLazyDLL("combase.dll")
	d3d11                  = syscall.NewLazyDLL("d3d11.dll")
	iidCaptureInterop      = syscall.GUID{Data1: 0x3628e81b, Data2: 0x3cac, Data3: 0x4c60, Data4: [8]byte{0xb7, 0xf4, 0x23, 0xce, 0x0e, 0x0c, 0x33, 0x56}}
	iidCaptureItem         = syscall.GUID{Data1: 0x79c3f95b, Data2: 0x31f7, Data3: 0x4ec2, Data4: [8]byte{0xa4, 0x64, 0x63, 0x2e, 0xf5, 0xd3, 0x07, 0x60}}
	iidFramePoolFactory    = syscall.GUID{Data1: 0x589b103f, Data2: 0x6bbc, Data3: 0x5df5, Data4: [8]byte{0xa9, 0x91, 0x02, 0xe2, 0x8b, 0x3b, 0x66, 0xd5}}
	iidCaptureSession2     = syscall.GUID{Data1: 0x2c39ae40, Data2: 0x7d2e, Data3: 0x5044, Data4: [8]byte{0x80, 0x4e, 0x8b, 0x67, 0x99, 0xd4, 0xcf, 0x9e}}
	iidDXGIDevice          = syscall.GUID{Data1: 0x54ec77fa, Data2: 0x1377, Data3: 0x44e6, Data4: [8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}}
	iidDirect3DDevice      = syscall.GUID{Data1: 0xa37624ab, Data2: 0x8d5f, Data3: 0x4650, Data4: [8]byte{0x9d, 0x3e, 0x9e, 0xae, 0x3d, 0x9b, 0xc6, 0x70}}
	iidDXGIResource1       = syscall.GUID{Data1: 0x30961379, Data2: 0x4609, Data3: 0x4a41, Data4: [8]byte{0x99, 0x8e, 0x54, 0xfe, 0x56, 0x7e, 0xe0, 0xc1}}
	iidDXGIKeyedMutex      = syscall.GUID{Data1: 0x9d8e1289, Data2: 0xd7b3, Data3: 0x465f, Data4: [8]byte{0x81, 0x26, 0x25, 0x0e, 0x34, 0x9a, 0xf8, 0x5d}}
	iidDXGIInterfaceAccess = syscall.GUID{Data1: 0xa9b3d012, Data2: 0x3df2, Data3: 0x4ee3, Data4: [8]byte{0xb8, 0xd1, 0x86, 0x95, 0xf4, 0x57, 0xd3, 0xc1}}
	iidD3D11Texture2D      = syscall.GUID{Data1: 0x6f15aaf2, Data2: 0xd208, Data3: 0x4e89, Data4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
	iidD3D11Multithread    = syscall.GUID{Data1: 0x9b7e4e00, Data2: 0x342c, Data3: 0x4106, Data4: [8]byte{0xa1, 0x9f, 0x4f, 0x27, 0x04, 0xf6, 0x89, 0xf0}}
)

// COM and WinRT vtable slots follow the Windows SDK interfaces. This helper is x64 only.
type captureObject struct {
	vtable *[128]uintptr
}

//go:uintptrescapes
func (object *captureObject) call(slot int, args ...uintptr) uintptr {
	result, _, _ := syscall.SyscallN(object.vtable[slot], append([]uintptr{uintptr(unsafe.Pointer(object))}, args...)...)
	return result
}

func (object *captureObject) release() { object.call(2) }

func (object *captureObject) query(id *syscall.GUID, out **captureObject) error {
	return checkCapture("QueryInterface", object.call(0, uintptr(unsafe.Pointer(id)), uintptr(unsafe.Pointer(out))))
}

func checkCapture(operation string, result uintptr) error {
	if int32(result) < 0 {
		return fmt.Errorf("%s: HRESULT %#08x", operation, uint32(result))
	}
	return nil
}

func captureFactory(name string, iid *syscall.GUID, out **captureObject) error {
	text, err := syscall.UTF16FromString(name)
	if err != nil {
		return err
	}
	var hstring uintptr
	create := winrt.NewProc("WindowsCreateString")
	result, _, _ := create.Call(uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(&hstring)))
	if err := checkCapture("WindowsCreateString", result); err != nil {
		return err
	}
	defer winrt.NewProc("WindowsDeleteString").Call(hstring)
	result, _, _ = winrt.NewProc("RoGetActivationFactory").Call(hstring, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(out)))
	return checkCapture("RoGetActivationFactory", result)
}

type screenTextureDesc struct {
	width, height, mipLevels, arraySize, format, samples, quality, usage, bind, access, misc uint32
}

const (
	bgra8Unorm                    = 87
	shaderResourceAndRenderTarget = 0x28
	sharedNtHandleAndKeyedMutex   = 0x900
	sharedResourceReadWrite       = 0x80000001
)

type windowsCapture struct {
	device, context, pool *captureObject
	self, parent          syscall.Handle
	size                  uint64 // ABI representation of SizeInt32, passed by value on Windows x64.
	textures              []*captureTexture
}

type captureTexture struct {
	texture, mutex *captureObject
	shared         syscall.Handle
	busy           bool
}

func (texture *captureTexture) close() {
	if texture.shared != 0 {
		syscall.CloseHandle(texture.shared)
		texture.shared = 0
	}
	if texture.mutex != nil {
		texture.mutex.release()
		texture.mutex = nil
	}
	if texture.texture != nil {
		texture.texture.release()
		texture.texture = nil
	}
}

func (capture *windowsCapture) prepareTextures() error {
	desc := screenTextureDesc{width: uint32(capture.size), height: uint32(capture.size >> 32),
		mipLevels: 1, arraySize: 1, format: bgra8Unorm, samples: 1,
		bind: shaderResourceAndRenderTarget, misc: sharedNtHandleAndKeyedMutex}
	for range 2 {
		texture := &captureTexture{}
		if err := checkCapture("CreateTexture2D", capture.device.call(5,
			uintptr(unsafe.Pointer(&desc)), 0, uintptr(unsafe.Pointer(&texture.texture)))); err != nil {
			texture.close()
			capture.closeTextures()
			return err
		}
		var resource *captureObject
		if err := texture.texture.query(&iidDXGIResource1, &resource); err != nil {
			texture.close()
			capture.closeTextures()
			return err
		}
		if err := texture.texture.query(&iidDXGIKeyedMutex, &texture.mutex); err != nil {
			resource.release()
			texture.close()
			capture.closeTextures()
			return err
		}
		if err := checkCapture("CreateSharedHandle", resource.call(13, 0, sharedResourceReadWrite, 0,
			uintptr(unsafe.Pointer(&texture.shared)))); err != nil {
			resource.release()
			texture.close()
			capture.closeTextures()
			return err
		}
		resource.release()
		capture.textures = append(capture.textures, texture)
	}
	return nil
}

func (capture *windowsCapture) closeTextures() {
	for _, texture := range capture.textures {
		texture.close()
	}
	capture.textures = nil
}

func (capture windowsCapture) nextFrame(slot *captureTexture) (syscall.Handle, error) {
	var frame, surface, dxgi, source *captureObject
	if err := checkCapture("TryGetNextFrame", capture.pool.call(7, uintptr(unsafe.Pointer(&frame)))); err != nil || frame == nil {
		return 0, err
	}
	defer func() { frame.release() }()
	// Consume the bounded pool and keep its newest frame when polling below refresh rate.
	for attempt := 0; attempt < 2; attempt++ {
		var newer *captureObject
		if err := checkCapture("TryGetNextFrame", capture.pool.call(7, uintptr(unsafe.Pointer(&newer)))); err != nil {
			return 0, err
		}
		if newer == nil {
			break
		}
		frame.release()
		frame = newer
	}
	if err := checkCapture("get_Surface", frame.call(6, uintptr(unsafe.Pointer(&surface)))); err != nil {
		return 0, err
	}
	defer surface.release()
	if err := surface.query(&iidDXGIInterfaceAccess, &dxgi); err != nil {
		return 0, err
	}
	defer dxgi.release()
	if err := checkCapture("GetInterface", dxgi.call(3, uintptr(unsafe.Pointer(&iidD3D11Texture2D)), uintptr(unsafe.Pointer(&source)))); err != nil {
		return 0, err
	}
	defer source.release()

	if result := slot.mutex.call(8, 0, 50); result != 0 {
		return 0, fmt.Errorf("AcquireSync: %#08x", uint32(result))
	}
	capture.context.call(47, uintptr(unsafe.Pointer(slot.texture)), uintptr(unsafe.Pointer(source))) // CopyResource
	capture.context.call(111)                                                                   // Flush
	if err := checkCapture("ReleaseSync", slot.mutex.call(9, 0)); err != nil {
		return 0, err
	}

	var remote syscall.Handle
	if err := syscall.DuplicateHandle(capture.self, slot.shared, capture.parent, &remote, 0, false, 2); err != nil {
		return 0, err
	}
	return remote, nil
}

func (capture windowsCapture) stream() error {
	handles := make(map[syscall.Handle]*captureTexture)
	closeRemote := func(handle syscall.Handle) {
		var local syscall.Handle
		if syscall.DuplicateHandle(capture.parent, handle, capture.self, &local, 0, false, 3) == nil {
			syscall.CloseHandle(local)
		}
		delete(handles, handle)
	}
	defer func() {
		for handle := range handles {
			closeRemote(handle)
		}
	}()
	acks := make(chan syscall.Handle, 4)
	frameRates := make(chan int, 4)
	go func() {
		defer close(acks)
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "fps ") {
				fps, err := strconv.Atoi(strings.TrimPrefix(scanner.Text(), "fps "))
				if err != nil || (fps != 30 && fps != 60 && fps != 90 && fps != 144) {
					return
				}
				frameRates <- fps
				continue
			}
			value, err := strconv.ParseUint(scanner.Text(), 16, 64)
			if err != nil {
				return
			}
			acks <- syscall.Handle(value)
		}
	}()
	tick := time.NewTicker(time.Second / 60)
	defer tick.Stop()
	for {
		select {
		case fps := <-frameRates:
			tick.Reset(time.Second / time.Duration(fps))
		case handle, open := <-acks:
			if !open {
				return nil
			}
			if handles[handle] != nil {
				handles[handle].busy = false
				closeRemote(handle)
			}
		case <-tick.C:
			var slot *captureTexture
			for _, candidate := range capture.textures {
				if !candidate.busy {
					slot = candidate
					break
				}
			}
			if slot == nil {
				continue
			}
			handle, err := capture.nextFrame(slot)
			if err != nil {
				return err
			}
			if handle == 0 {
				continue
			}
			slot.busy = true
			handles[handle] = slot
			if _, err := fmt.Fprintf(os.Stdout, "%x %d %d\n", handle, uint32(capture.size), uint32(capture.size>>32)); err != nil {
				return err
			}
		}
	}
}

func runCapture(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("missing capture monitor coordinates")
	}
	x, err := strconv.ParseInt(args[0], 10, 32)
	if err != nil {
		return err
	}
	y, err := strconv.ParseInt(args[1], 10, 32)
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := winrt.NewProc("RoInitialize").Call(1)
	if err := checkCapture("RoInitialize", result); err != nil {
		return err
	}
	defer winrt.NewProc("RoUninitialize").Call()
	user32.NewProc("SetThreadDpiAwarenessContext").Call(^uintptr(3)) // PER_MONITOR_AWARE_V2
	monitor, _, _ := user32.NewProc("MonitorFromPoint").Call(uintptr(uint64(uint32(x))|uint64(uint32(y))<<32), 0)
	if monitor == 0 {
		return fmt.Errorf("capture monitor unavailable")
	}

	var capture windowsCapture
	capture.parent, err = syscall.OpenProcess(0x0040, false, uint32(os.Getppid())) // PROCESS_DUP_HANDLE
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(capture.parent)
	capture.self, err = syscall.GetCurrentProcess()
	if err != nil {
		return err
	}

	var interop, item, factory, dxgiDevice, inspectableDevice, winrtDevice, session, cursor *captureObject
	if err := captureFactory("Windows.Graphics.Capture.GraphicsCaptureItem", &iidCaptureInterop, &interop); err != nil {
		return err
	}
	defer interop.release()
	if err := checkCapture("CreateForMonitor", interop.call(4, monitor, uintptr(unsafe.Pointer(&iidCaptureItem)), uintptr(unsafe.Pointer(&item)))); err != nil {
		return err
	}
	defer item.release()
	if err := checkCapture("get_Size", item.call(7, uintptr(unsafe.Pointer(&capture.size)))); err != nil {
		return err
	}
	if uint32(capture.size) == 0 || capture.size>>32 == 0 {
		return fmt.Errorf("invalid capture size")
	}

	const d3d11SDKVersion = 7
	result, _, _ = d3d11.NewProc("D3D11CreateDevice").Call(0, 1, 0, 0x20, 0, 0, d3d11SDKVersion,
		uintptr(unsafe.Pointer(&capture.device)), 0, uintptr(unsafe.Pointer(&capture.context)))
	if err := checkCapture("D3D11CreateDevice", result); err != nil {
		return err
	}
	defer capture.device.release()
	defer capture.context.release()
	if err := capture.prepareTextures(); err != nil {
		return err
	}
	defer capture.closeTextures()
	var multithread *captureObject
	if err := capture.context.query(&iidD3D11Multithread, &multithread); err != nil {
		return err
	}
	multithread.call(5, 1) // SetMultithreadProtected for the free-threaded frame pool.
	multithread.release()
	if err := capture.device.query(&iidDXGIDevice, &dxgiDevice); err != nil {
		return err
	}
	defer dxgiDevice.release()
	result, _, _ = d3d11.NewProc("CreateDirect3D11DeviceFromDXGIDevice").Call(uintptr(unsafe.Pointer(dxgiDevice)), uintptr(unsafe.Pointer(&inspectableDevice)))
	if err := checkCapture("CreateDirect3D11DeviceFromDXGIDevice", result); err != nil {
		return err
	}
	defer inspectableDevice.release()
	if err := inspectableDevice.query(&iidDirect3DDevice, &winrtDevice); err != nil {
		return err
	}
	defer winrtDevice.release()
	if err := captureFactory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", &iidFramePoolFactory, &factory); err != nil {
		return err
	}
	defer factory.release()
	if err := checkCapture("CreateFreeThreaded", factory.call(6, uintptr(unsafe.Pointer(winrtDevice)), bgra8Unorm, 2, uintptr(capture.size), uintptr(unsafe.Pointer(&capture.pool)))); err != nil {
		return err
	}
	defer capture.pool.release()
	if err := checkCapture("CreateCaptureSession", capture.pool.call(10, uintptr(unsafe.Pointer(item)), uintptr(unsafe.Pointer(&session)))); err != nil {
		return err
	}
	defer session.release()
	if err := session.query(&iidCaptureSession2, &cursor); err != nil {
		return err
	}
	defer cursor.release()
	if err := checkCapture("put_IsCursorCaptureEnabled", cursor.call(7, 0)); err != nil {
		return err
	}
	if err := checkCapture("StartCapture", session.call(6)); err != nil {
		return err
	}
	return capture.stream()
}
