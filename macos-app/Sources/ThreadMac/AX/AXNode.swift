import Foundation

/// A read-only view of one Accessibility element: role, a few well-known attributes, text, and
/// children. Everything the AX sensor's logic needs is expressed against THIS protocol, never
/// against `AXUIElement` directly -- so the snapshot / diff / settle engine and every adapter are
/// exercised in CI against in-memory fake trees, with no GUI, no Accessibility permission, and no
/// running Cursor. `LiveAXNode` is the one implementation that talks to the real API.
///
/// Attribute names are the raw `kAX...Attribute` strings (see `AXAttribute`); an implementation
/// returns nil for anything it can't read rather than throwing.
protocol AXNode {
    /// `kAXRoleAttribute`, e.g. "AXGroup", "AXStaticText", "AXWebArea". "" if unreadable.
    var axRole: String { get }
    /// `kAXSubroleAttribute`, e.g. "AXStandardWindow". nil if none.
    var axSubrole: String? { get }
    /// `kAXTitleAttribute`.
    var axTitle: String? { get }
    /// `kAXDescriptionAttribute` -- Electron/DOM-bridged apps often put semantic hints here.
    var axDescription: String? { get }
    /// `kAXIdentifierAttribute` -- when an Electron app bridges DOM ids, this is where they land.
    var axIdentifier: String? { get }
    /// `kAXValueAttribute` rendered as a string (`AXStaticText` content, a text field's text, ...).
    var axValue: String? { get }
    /// Any string attribute by raw name, for the odd case the ones above don't cover.
    func axString(_ attribute: String) -> String?
    /// `kAXChildrenAttribute`. Empty, never nil.
    var axChildren: [AXNode] { get }
}

extension AXNode {
    /// Depth-first pre-order walk of this node and its whole subtree. Bounded so a pathological or
    /// cyclic tree (shouldn't happen via the real API, can happen in a hand-built fake) can't spin.
    func flattened(maxDepth: Int = 40, maxNodes: Int = 20_000) -> [AXNode] {
        var out: [AXNode] = []
        var stack: [(node: AXNode, depth: Int)] = [(self, 0)]
        while let (node, depth) = stack.popLast() {
            out.append(node)
            if out.count >= maxNodes { break }
            if depth >= maxDepth { continue }
            // Reverse so children come off the stack in natural order -> `out` is pre-order.
            for child in node.axChildren.reversed() { stack.append((child, depth + 1)) }
        }
        return out
    }

    /// The best single text run for this node: its value, else its description, else its title.
    /// Trimmed; nil if nothing usable.
    var axText: String? {
        for candidate in [axValue, axDescription, axTitle] {
            if let t = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                return t
            }
        }
        return nil
    }

    /// Lowercased haystack of the identity-bearing attributes, for adapter keyword matching.
    var axHints: String {
        [axIdentifier, axDescription, axTitle, axSubrole]
            .compactMap { $0 }.joined(separator: " ").lowercased()
    }
}

/// Raw Accessibility attribute name constants, kept in one place so the fake and the live node
/// agree on spelling.
enum AXAttribute {
    static let role = "AXRole"
    static let subrole = "AXSubrole"
    static let title = "AXTitle"
    static let description = "AXDescription"
    static let identifier = "AXIdentifier"
    static let value = "AXValue"
    static let children = "AXChildren"
    static let focusedUIElement = "AXFocusedUIElement"
    static let windows = "AXWindows"
    static let mainWindow = "AXMainWindow"
}
