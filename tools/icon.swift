import AppKit

guard CommandLine.arguments.count == 2 else { exit(1) }
let size = 1024
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { exit(1) }

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
    NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
let field = NSBezierPath(roundedRect: NSRect(x: 83, y: 83, width: 858, height: 858), xRadius: 190, yRadius: 190)
NSGradient(starting: color(0.13, 0.25, 0.30), ending: color(0.05, 0.09, 0.15))?.draw(in: field, angle: -65)

let rail = NSBezierPath()
rail.move(to: NSPoint(x: 246, y: 318))
rail.line(to: NSPoint(x: 776, y: 318))
rail.lineWidth = 30
rail.lineCapStyle = .round
color(0.90, 0.58, 0.38).setStroke()
rail.stroke()

let bird = NSBezierPath()
bird.move(to: NSPoint(x: 245, y: 424))
bird.curve(to: NSPoint(x: 440, y: 633), controlPoint1: NSPoint(x: 333, y: 462), controlPoint2: NSPoint(x: 374, y: 609))
bird.curve(to: NSPoint(x: 677, y: 704), controlPoint1: NSPoint(x: 514, y: 666), controlPoint2: NSPoint(x: 573, y: 765))
bird.curve(to: NSPoint(x: 717, y: 654), controlPoint1: NSPoint(x: 700, y: 690), controlPoint2: NSPoint(x: 711, y: 676))
bird.line(to: NSPoint(x: 789, y: 624))
bird.line(to: NSPoint(x: 720, y: 601))
bird.curve(to: NSPoint(x: 600, y: 425), controlPoint1: NSPoint(x: 716, y: 501), controlPoint2: NSPoint(x: 665, y: 445))
bird.curve(to: NSPoint(x: 245, y: 424), controlPoint1: NSPoint(x: 490, y: 378), controlPoint2: NSPoint(x: 370, y: 431))
bird.close()
NSGradient(starting: color(0.71, 0.99, 0.88), ending: color(0.37, 0.79, 0.74))?.draw(in: bird, angle: 110)

let wing = NSBezierPath()
wing.move(to: NSPoint(x: 321, y: 454))
wing.curve(to: NSPoint(x: 621, y: 580), controlPoint1: NSPoint(x: 439, y: 445), controlPoint2: NSPoint(x: 563, y: 499))
wing.lineWidth = 23
wing.lineCapStyle = .round
color(0.17, 0.50, 0.50).setStroke()
wing.stroke()
color(0.08, 0.20, 0.24).setFill()
NSBezierPath(ovalIn: NSRect(x: 665, y: 647, width: 25, height: 25)).fill()
for x in [510, 576] {
    let toe = NSBezierPath()
    toe.move(to: NSPoint(x: x, y: 409))
    toe.line(to: NSPoint(x: x - 11, y: 342))
    toe.lineWidth = 21
    toe.lineCapStyle = .round
    color(0.90, 0.58, 0.38).setStroke()
    toe.stroke()
}

NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
