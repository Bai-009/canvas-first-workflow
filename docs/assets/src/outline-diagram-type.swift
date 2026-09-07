// Outline locally installed fonts so exported diagrams retain their typography.
import Foundation
import CoreText
import CoreGraphics
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let doc = try XMLDocument(contentsOf: input)
for item in try doc.nodes(forXPath: "//*[local-name()='text']") {
    guard let el = item as? XMLElement else { continue }
    func attr(_ key: String, _ fallback: String) -> String { el.attribute(forName: key)?.stringValue ?? fallback }
    let value = el.stringValue ?? ""
    let x = Double(attr("x", "0"))!, y = Double(attr("y", "0"))!
    let size = Double(attr("font-size", "16"))!
    let family = attr("font-family", "")
    let names = ["Baskerville": "Baskerville", "Songti SC": "STSongti-SC-Regular", "PingFang SC": "PingFangSC-Regular"]
    let font = CTFontCreateWithName((names[family] ?? "AvenirNext-Regular") as CFString, size, nil)
    var attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font]
    if let spacing = Double(attr("letter-spacing", "")) { attributes[NSAttributedString.Key(kCTKernAttributeName as String)] = spacing }
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: value, attributes: attributes))
    let group = XMLElement(name: "g")
    for (key, val) in [("transform", "translate(\(x) \(y)) scale(1 -1)"), ("fill", attr("fill", "#262824")), ("aria-label", value)] {
        group.addAttribute(XMLNode.attribute(withName: key, stringValue: val) as! XMLNode)
    }
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
        let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
        for i in 0..<count {
            var transform = CGAffineTransform(translationX: positions[i].x, y: positions[i].y)
            guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], &transform) else { continue }
            var d = ""
            func xy(_ p: CGPoint) -> String { String(format: "%.3f %.3f", Double(p.x), Double(p.y)) }
            path.applyWithBlock { ptr in
                let e = ptr.pointee
                switch e.type {
                case .moveToPoint: d += "M" + xy(e.points[0])
                case .addLineToPoint: d += "L" + xy(e.points[0])
                case .addQuadCurveToPoint: d += "Q" + xy(e.points[0]) + " " + xy(e.points[1])
                case .addCurveToPoint: d += "C" + xy(e.points[0]) + " " + xy(e.points[1]) + " " + xy(e.points[2])
                case .closeSubpath: d += "Z"
                @unknown default: break
                }
            }
            let shape = XMLElement(name: "path")
            shape.addAttribute(XMLNode.attribute(withName: "d", stringValue: d) as! XMLNode)
            group.addChild(shape)
        }
    }
    let parent = el.parent as! XMLElement
    parent.replaceChild(at: el.index, with: group)
}
try doc.xmlData.write(to: output)
