"""Zeigt den Verbrauch einer Claude-Code-Session und ihrer Subagents (nur lesend).

Aufruf (Pfad ohne .jsonl, Unterordner subagents/ liegt daneben):

    py -I scripts/agent-usage.py ~/.claude/projects/<slug-des-arbeitsverzeichnisses>/<session-id>

Der Slug ist der Pfad des Arbeitsverzeichnisses der Session mit '-' statt '/' (bei T3-Worktrees
also der Worktree-Pfad, nicht der Repo-Pfad); `ls ~/.claude/projects | grep termdock` zeigt alle.

Pro Transkript (Hauptsession und subagents/*.jsonl): Modell, Turns, Ø- und Max-Kontext,
Cache-Neuaufbauten über 100k Token, Tool-Ergebnisse über 20.000 Zeichen und Anteil am
Gesamtgewicht. Danach Gewicht pro Modell und pro Stunde (UTC).

Gewicht = Input + Cache-Writes + 0,1 * Cache-Reads + 5 * Output (Token). Das ist eine
grobe Näherung für die Last auf das Kontingent, keine Abrechnung. Steht eine Antwort in
mehreren Zeilen (Streaming), zählt die letzte Zeile mit den vollständigen Output-Tokens.
Große Tool-Ergebnisse zählen nur Textzeichen, keine Bilder.

Beispiel (gekürzt):

    Gewicht gesamt 62.1M, 40 Transkripte
    Gewicht  Anteil  Turns  Ø-Ktx  Max-Ktx  Neuaufb.  Große  Modell   Transkript
      25.2M  40.6%    415   434k     717k        12      5  opus    agent-a32a1bcb4007545a2
"""
import collections
import glob
import json
import os
import sys

REBUILD_TOKENS = 100_000
BIG_RESULT_CHARS = 20_000
JSONL_SUFFIX = ".jsonl"


def weight(usage):
    """Grobe Näherung der Kontingentlast, siehe Modul-Docstring."""
    return (
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
        + 0.1 * (usage.get("cache_read_input_tokens") or 0)
        + 5 * (usage.get("output_tokens") or 0)
    )


def context_size(usage):
    return sum(
        usage.get(key) or 0
        for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    )


def text_length(content):
    """Zeichen im Text eines Tool-Ergebnisses; Bilder und JSON-Escapes zählen nicht."""
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(part.get("text") or "") for part in content
                   if isinstance(part, dict) and part.get("type") == "text")
    return 0


def count_big_results(message):
    """Zählt Tool-Ergebnisse einer User-Nachricht, die BIG_RESULT_CHARS überschreiten."""
    content = message.get("content")
    if not isinstance(content, list):
        return 0
    return sum(
        1
        for part in content
        if isinstance(part, dict)
        and part.get("type") == "tool_result"
        and text_length(part.get("content")) > BIG_RESULT_CHARS
    )


def read_transcript(path):
    """Liest ein Transkript: letzte Zeile je Nachrichten-ID und Zahl großer Tool-Ergebnisse."""
    # Eine gestreamte Antwort steht in mehreren Zeilen mit derselben ID; erst die
    # letzte trägt die vollständigen output_tokens. Deshalb gewinnt die letzte Zeile.
    messages = {}
    big_results = 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = record.get("message") or {}
            if record.get("type") == "user":
                big_results += count_big_results(message)
            usage = message.get("usage")
            if not usage:
                continue
            message_id = message.get("id") or record.get("uuid")
            messages[message_id] = (usage, record.get("timestamp") or "", message.get("model") or "-")
    return messages, big_results


def analyse(path):
    """Liest ein Transkript und gibt Kennzahlen und Gewicht pro Stunde zurück."""
    messages, big_results = read_transcript(path)

    contexts = []
    per_hour = collections.Counter()
    models = collections.Counter()
    total_weight = 0.0
    rebuilds = 0
    for usage, timestamp, model in messages.values():
        contexts.append(context_size(usage))
        if (usage.get("cache_creation_input_tokens") or 0) > REBUILD_TOKENS:
            rebuilds += 1
        current = weight(usage)
        total_weight += current
        per_hour[timestamp[:13]] += current
        models[model] += current
    return {
        "turns": len(contexts),
        "avg_context": sum(contexts) / len(contexts) if contexts else 0,
        "max_context": max(contexts, default=0),
        "rebuilds": rebuilds,
        "big_results": big_results,
        "weight": total_weight,
        "per_hour": per_hour,
        "model": models.most_common(1)[0][0] if models else "-",
        "models": models,
    }


def short_model(name):
    for family in ("opus", "sonnet", "haiku"):
        if family in name:
            return family
    return name[:12]


def main():
    if len(sys.argv) != 2:
        sys.exit("Aufruf: py -I scripts/agent-usage.py <pfad-zur-session-ohne-.jsonl>")
    root = sys.argv[1].rstrip("/").removesuffix(JSONL_SUFFIX)
    paths = [root + JSONL_SUFFIX] + sorted(glob.glob(os.path.join(root, "subagents", "*" + JSONL_SUFFIX)))
    paths = [path for path in paths if os.path.isfile(path)]
    if not paths:
        sys.exit("Keine Transkripte gefunden.")

    results = []
    for path in paths:
        name = "main" if path == root + JSONL_SUFFIX else os.path.basename(path).removesuffix(JSONL_SUFFIX)
        results.append((name, analyse(path)))

    total = sum(result["weight"] for _, result in results) or 1.0
    per_hour = collections.Counter()
    per_model = collections.Counter()
    for _, result in results:
        per_hour.update(result["per_hour"])
        per_model.update(result["models"])

    print(f"Gewicht gesamt {total / 1e6:.1f}M, {len(results)} Transkripte")
    print("Gewicht  Anteil  Turns  Ø-Ktx  Max-Ktx  Neuaufb.  Große  Modell   Transkript")
    for name, result in sorted(results, key=lambda item: -item[1]["weight"]):
        print(
            f"{result['weight'] / 1e6:6.1f}M {result['weight'] / total:6.1%} "
            f"{result['turns']:6d} {result['avg_context'] / 1e3:5.0f}k {result['max_context'] / 1e3:7.0f}k "
            f"{result['rebuilds']:9d} {result['big_results']:6d}  "
            f"{short_model(result['model']):7} {name[:40]}"
        )

    print("\nModellanteil:")
    for model, value in per_model.most_common():
        print(f"  {short_model(model):8} {value / total:6.1%}")

    print("\nGewicht pro Stunde (UTC):")
    for hour, value in sorted(per_hour.items()):
        print(f"  {hour or '?':13} {value / 1e6:6.2f}M {'#' * int(value / total * 100)}")


if __name__ == "__main__":
    main()
