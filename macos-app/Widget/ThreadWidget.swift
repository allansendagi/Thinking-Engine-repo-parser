import SwiftUI
import WidgetKit

/// The "Recent ideas" widget: your newest thinking and how many questions are still open, on the
/// desktop or in Notification Center. It only reads a small snapshot the Thread app writes into the
/// shared group container; it never talks to the network.

struct RecentEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct RecentProvider: TimelineProvider {
    func placeholder(in context: Context) -> RecentEntry { RecentEntry(date: .now, snapshot: Self.sample) }

    func getSnapshot(in context: Context, completion: @escaping (RecentEntry) -> Void) {
        completion(RecentEntry(date: .now, snapshot: context.isPreview ? Self.sample : WidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentEntry>) -> Void) {
        let snapshot = WidgetStore.load()
        // One entry every 15 minutes for the next two hours, so "24m ago" stays honest without the
        // widget doing any work in between. The app reloads the timeline whenever your ideas change.
        let entries = (0..<9).map { RecentEntry(date: .now.addingTimeInterval(Double($0) * 900), snapshot: snapshot) }
        completion(Timeline(entries: entries, policy: .after(.now.addingTimeInterval(2 * 3600))))
    }

    static let sample = WidgetSnapshot(
        updatedAt: .now,
        ideas: [
            .init(id: "1", title: "Authority should be checkable by a machine", source: "Claude", touched: .now.addingTimeInterval(-1_400)),
            .init(id: "2", title: "Every decision carries its authority", source: "ChatGPT", touched: .now.addingTimeInterval(-7_200)),
            .init(id: "3", title: "Delegation should only ever narrow", source: "Cursor", touched: .now.addingTimeInterval(-90_000)),
        ],
        openLoops: 3
    )
}

/// A tappable area that opens a thread:// address. (The look-check renderer can't draw links, so it
/// swaps in the plain content; the shipped widget always uses a real link.)
struct OpenLink<Content: View>: View {
    let url: URL
    @ViewBuilder let content: Content
    var body: some View {
        #if WIDGET_RENDER
        content
        #else
        Link(destination: url) { content }
        #endif
    }
}

/// "just now" / "24m ago" / "2h ago" / "3d ago" / "Aug 17": the same wording as the app's lists.
func agoText(from then: Date, to now: Date) -> String {
    let s = now.timeIntervalSince(then)
    switch s {
    case ..<90: return "just now"
    case ..<3600: return "\(Int(s / 60))m ago"
    case ..<86_400: return "\(Int(s / 3600))h ago"
    case ..<604_800: return "\(Int(s / 86_400))d ago"
    default:
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: then)
    }
}

struct RecentView: View {
    let entry: RecentEntry
    /// Only for the renderer that checks how the widget looks; WidgetKit supplies the real family.
    var previewFamily: WidgetFamily? = nil
    @Environment(\.widgetFamily) private var environmentFamily

    private var family: WidgetFamily { previewFamily ?? environmentFamily }
    private var limit: Int { family == .systemSmall ? 2 : 3 }

    var body: some View {
        Group {
            if let s = entry.snapshot, !s.ideas.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkle.magnifyingglass").font(.system(size: 11, weight: .semibold))
                        Text("Recent").font(.system(size: 12, weight: .semibold))
                        Spacer(minLength: 0)
                        if s.openLoops > 0 {
                            OpenLink(url: URL(string: "thread://loops")!) {
                                Text("\(s.openLoops) open").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .foregroundStyle(.secondary)
                    ForEach(s.ideas.prefix(limit)) { idea in
                        OpenLink(url: URL(string: "thread://idea/\(idea.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? idea.id)")!) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(idea.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                if let touched = idea.touched {
                                    Text([idea.source, agoText(from: touched, to: entry.date)].compactMap { $0 }.joined(separator: " · "))
                                        .font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "sparkle.magnifyingglass").font(.system(size: 20)).foregroundStyle(.secondary)
                    Text("Open Thread to see your ideas here").font(.system(size: 12)).multilineTextAlignment(.center).foregroundStyle(.secondary)
                }
            }
        }
        .widgetURL(URL(string: "thread://loops"))
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct RecentIdeasWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ThreadRecentIdeas", provider: RecentProvider()) { entry in
            RecentView(entry: entry)
        }
        .configurationDisplayName("Recent ideas")
        .description("Your newest thinking, and the questions still open.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

#if !WIDGET_RENDER
@main
struct ThreadWidgets: WidgetBundle {
    var body: some Widget { RecentIdeasWidget() }
}
#endif
