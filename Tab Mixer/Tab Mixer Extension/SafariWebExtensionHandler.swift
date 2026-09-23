//
//  SafariWebExtensionHandler.swift
//  Tab Mixer Extension
//
//  Receives log batches from the extension's background script and writes
//  them to the unified log (subsystem com.bezalel.tabmixer). Read with
//  tools/logs.sh.
//

import SafariServices
import os

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let subsystem = "com.bezalel.tabmixer"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        // Which Safari profile this request came from (first 8 chars of its UUID).
        let profileID: UUID?
        if #available(macOS 14.0, *) {
            profileID = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profileID = request?.userInfo?["profile"] as? UUID
        }
        let profile = profileID?.uuidString.prefix(8).lowercased() ?? "none"

        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        var logged = 0

        if message?["type"] as? String == "log",
           let entries = message?["entries"] as? [[String: Any]] {
            for entry in entries {
                emit(entry, profile: profile)
                logged += 1
            }
        } else {
            Logger(subsystem: Self.subsystem, category: "native")
                .error("p:\(profile, privacy: .public) unrecognised message: \(String(describing: message), privacy: .public)")
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true, "logged": logged]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func emit(_ entry: [String: Any], profile: String) {
        let src = entry["src"] as? String ?? "?"
        let level = entry["level"] as? String ?? "info"
        let event = entry["event"] as? String ?? "?"
        let data = entry["data"] as? String ?? ""

        // Where it came from: t<tab>/f<frame>, "top" for the main frame, plus origin.
        var origin = ""
        if let tab = entry["tab"] { origin += "t\(tab)" }
        if let frame = entry["frame"] { origin += "/f\(frame)" }
        if entry["top"] as? Bool == true { origin += " top" }
        if let o = entry["origin"] as? String, !o.isEmpty { origin += " \(o)" }
        if origin.isEmpty { origin = "-" }

        let line = "p:\(profile) [\(origin)] \(level.uppercased()) \(event) \(data)"
        let logger = Logger(subsystem: Self.subsystem, category: src)
        if level == "error" {
            logger.error("\(line, privacy: .public)")
        } else {
            logger.notice("\(line, privacy: .public)")
        }
    }
}
