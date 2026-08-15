/**
 * Aura — Tinnitus Guidance & Everyday Assistant Companion.
 *
 * End-to-end integration combining EchoSense's clinical intelligence with
 * Aura's empathetic evidence-based guidance, quick prompt pills, interactive
 * action triggers (assessment, sound masker, clinician consultation),
 * and red-flag otological safety alerts.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError, type ChatReply } from "../api/client";
import { useSession } from "../state/session";
import { Chip, Loading, Panel, RichText, fmt, useAsync } from "../components/ui";
import {
  IconAlert,
  IconCalendar,
  IconChevronRight,
  IconClipboard,
  IconPhone,
  IconReplay,
  IconShield,
  IconSpark,
  IconUser,
  IconWave,
} from "../components/icons";
import {
  EMPATHETIC_RESPONSES,
  QUICK_PROMPTS,
  matchLocalQuery,
} from "../data/tinnitusKnowledgeBase";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: string;
  engine?: string;
  locale?: string;
  safety?: string | null;
  suggestions?: { label: string; intent: string; action?: string }[];
  distortions?: { key: string; name: string; correction: string }[];
  created_at?: string;
  isRedFlag?: boolean;
  actionTrigger?: "assessment" | "therapy" | "consultation" | "results";
}

export default function Chat() {
  const { t } = useTranslation();
  const locale = useSession((s) => s.locale);
  const toast = useSession((s) => s.toast);
  const navigate = useNavigate();

  const meta = useAsync(() => api.chat.meta(), []);
  const history = useAsync(() => api.chat.history(60), []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [crisis, setCrisis] = useState<ChatReply | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!history.data) return;
    if (history.data.messages.length > 0) {
      setMessages(
        history.data.messages.map((m: any) => ({
          id: String(m.id),
          role: m.role,
          content: m.content,
          intent: m.intent,
          engine: m.engine,
          locale: m.locale,
          safety: m.safety_flag,
          created_at: m.created_at,
          isRedFlag: m.safety_flag === "urgent_medical" || m.intent === "medical_emergency",
        }))
      );
    } else {
      // Initialize with Aura's warm clinical greeting
      setMessages([
        {
          id: "initial-aura",
          role: "assistant",
          content: EMPATHETIC_RESPONSES.greeting,
          intent: "greeting",
          engine: "aura+offline",
          suggestions: [
            { label: "Take AI Assessment", intent: "results_meaning", action: "open_assessment" },
            { label: "How is tinnitus treated?", intent: "treatment_options" },
            { label: "Help me sleep tonight", intent: "sleep", action: "open_therapy" },
          ],
        },
      ]);
    }
  }, [history.data]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  function handleAction(action?: string) {
    if (!action) return;
    switch (action) {
      case "open_assessment":
      case "start_assessment":
        navigate("/assessment");
        break;
      case "open_therapy":
      case "open_masker":
        navigate("/rehabilitation");
        break;
      case "book_consultation":
      case "message_clinician":
        navigate("/consultation");
        break;
      case "open_results":
      case "view_results":
        navigate("/results");
        break;
      default:
        break;
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setDraft("");
    setBusy(true);
    const userMessage: Message = { id: `u-${Date.now()}`, role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const reply = await api.chat.send(trimmed, locale);
      const isRedFlag =
        reply.safety_flag === "urgent_medical" ||
        reply.intent === "medical_emergency" ||
        trimmed.toLowerCase().includes("pulsatile") ||
        trimmed.toLowerCase().includes("one ear");

      let actionTrigger: "assessment" | "therapy" | "consultation" | "results" | undefined;
      if (reply.intent === "identification_types" || reply.intent === "results_meaning") {
        actionTrigger = "assessment";
      } else if (reply.intent === "treatment_options" || reply.intent === "therapy_help") {
        actionTrigger = "therapy";
      } else if (reply.intent === "appointment" || isRedFlag) {
        actionTrigger = "consultation";
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: reply.reply,
          intent: reply.intent,
          engine: reply.engine,
          locale: reply.locale,
          safety: reply.safety_flag,
          suggestions: reply.suggestions,
          distortions: reply.distortions,
          isRedFlag,
          actionTrigger,
        },
      ]);

      if (reply.safety_flag) {
        setCrisis(reply);
        toast(t("chat.notified"), "crit");
      }
      if (reply.note) toast(reply.note, "info");
    } catch (error) {
      // Offline fallback using local knowledge base
      const localResult = matchLocalQuery(trimmed);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: localResult.text,
          intent: localResult.type,
          engine: "aura-knowledge",
          isRedFlag: localResult.type === "RED_FLAG_WARNING",
          actionTrigger:
            localResult.type === "TRIGGER_ASSESSMENT"
              ? "assessment"
              : localResult.type === "TRIGGER_MASKER"
              ? "therapy"
              : localResult.type === "RED_FLAG_WARNING"
              ? "consultation"
              : undefined,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function clearHistory() {
    try {
      await api.chat.clear();
      setMessages([
        {
          id: `initial-aura-${Date.now()}`,
          role: "assistant",
          content: EMPATHETIC_RESPONSES.greeting,
          intent: "greeting",
          engine: "aura+offline",
          suggestions: [
            { label: "Take AI Assessment", intent: "results_meaning", action: "open_assessment" },
            { label: "How is tinnitus treated?", intent: "treatment_options" },
            { label: "Help me sleep tonight", intent: "sleep", action: "open_therapy" },
          ],
        },
      ]);
      toast(t("chat.cleared"), "info");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("chat.clearFailed"), "crit");
    }
  }

  return (
    <div className="stack stack-5">
      {/* Header with Aura Persona & Online Status */}
      <header className="row row--between row--wrap" style={{ gap: "var(--s3)" }}>
        <div className="stack stack-1">
          <div className="row row--tight" style={{ alignItems: "center" }}>
            <span className="label label--signal">EchoSense Aura</span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "var(--fs-micro)",
                fontWeight: 600,
                color: "var(--ok-ink, #059669)",
                background: "var(--ok-wash, rgba(16,185,129,0.12))",
                padding: "2px 8px",
                borderRadius: "999px",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  backgroundColor: "var(--ok-ink, #10b981)",
                  display: "inline-block",
                }}
              />
              Clinical AI Companion
            </span>
          </div>
          <h1>{t("chat.title")}</h1>
          <p className="meta" style={{ maxWidth: "68em" }}>
            Always here to support, listen, and explain evidence-based tinnitus therapies, habituation science, and symptom analysis.
          </p>
        </div>

        <div className="row row--tight">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={clearHistory}
            title="Reset conversation"
          >
            <IconReplay size={14} style={{ marginRight: "4px" }} />
            {t("chat.clear")}
          </button>
        </div>
      </header>

      {/* Pinned Crisis Resources if flagged */}
      {crisis && crisis.crisis_resources.length > 0 && (
        <Panel tone="crit" title={t("chat.crisis.pinnedTitle")} bracketed>
          <div className="stack stack-3">
            <p style={{ fontSize: "var(--fs-small)" }}>{t("chat.crisis.pinnedLead")}</p>
            <div className="grid grid-2">
              {crisis.crisis_resources.map((resource) => (
                <div key={resource.name} className="stack stack-1">
                  <strong style={{ fontSize: "var(--fs-small)" }}>
                    {t(`chat.resource.${resource.name}`, { defaultValue: resource.name })}
                  </strong>
                  <span
                    className="mono"
                    style={{ fontSize: "var(--fs-body)", color: "var(--crit-ink)", fontWeight: 700 }}
                  >
                    {resource.contact}
                  </span>
                  <span className="meta dim">
                    {t(`chat.region.${resource.region}`, { defaultValue: resource.region })}
                  </span>
                </div>
              ))}
            </div>
            <p className="meta">{t("chat.crisis.pinnedFoot")}</p>
          </div>
        </Panel>
      )}

      {/* Quick Prompt Carousel Pills */}
      <div
        className="row row--tight"
        style={{
          overflowX: "auto",
          paddingBottom: "var(--s2)",
          whiteSpace: "nowrap",
          scrollbarWidth: "thin",
        }}
      >
        {QUICK_PROMPTS.map((prompt, idx) => (
          <button
            key={idx}
            type="button"
            className="chip chip--ghost"
            style={{
              cursor: "pointer",
              fontSize: "var(--fs-tiny)",
              padding: "6px 12px",
              flexShrink: 0,
              borderRadius: "999px",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--ink)",
              transition: "all 0.15s ease",
            }}
            onClick={() => {
              if (prompt.action) {
                handleAction(prompt.action);
              } else {
                send(prompt.text);
              }
            }}
          >
            {prompt.text}
          </button>
        ))}
      </div>

      {/* Conversation Stream */}
      <Panel flush bracketed className="chatpanel">
        <div className="chatpanel__log" style={{ minHeight: "420px", maxHeight: "65vh" }}>
          {history.loading && <Loading label={t("chat.loadingConversation")} rows={2} />}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`msg fade-in ${message.role === "user" ? "msg--user" : ""} ${
                message.isRedFlag || message.safety ? "msg--crisis" : ""
              }`}
            >
              <span className="msg__avatar">
                {message.role === "user" ? (
                  <IconUser size={16} />
                ) : (
                  <IconSpark size={16} style={{ color: "var(--signal-ink)" }} />
                )}
              </span>

              <div className="stack stack-2" style={{ minWidth: 0, width: "100%" }}>
                {/* Red Flag Alert Badge */}
                {message.isRedFlag && (
                  <div
                    className="row row--tight"
                    style={{
                      padding: "6px 10px",
                      background: "rgba(239, 68, 68, 0.1)",
                      border: "1px solid var(--crit-border, rgba(239, 68, 68, 0.3))",
                      borderRadius: "6px",
                      color: "var(--crit-ink, #b91c1c)",
                      fontSize: "var(--fs-tiny)",
                      fontWeight: 600,
                    }}
                  >
                    <IconAlert size={15} style={{ flexShrink: 0 }} />
                    <span>Otological Flag — Specialist Consultation Advised</span>
                  </div>
                )}

                <div className="msg__body">
                  <RichText text={message.content} />
                </div>

                {/* Interactive Action Buttons */}
                {message.role === "assistant" && (
                  <div className="row row--tight row--wrap" style={{ marginTop: "var(--s2)" }}>
                    {message.actionTrigger === "assessment" && (
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        onClick={() => navigate("/assessment")}
                      >
                        <IconClipboard size={14} style={{ marginRight: "4px" }} />
                        Launch AI Tinnitus Assessment
                      </button>
                    )}

                    {message.actionTrigger === "therapy" && (
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        onClick={() => navigate("/rehabilitation")}
                      >
                        <IconWave size={14} style={{ marginRight: "4px" }} />
                        Open Sound Therapy & Masker
                      </button>
                    )}

                    {message.actionTrigger === "consultation" && (
                      <button
                        type="button"
                        className="btn btn--sm btn--crit"
                        onClick={() => navigate("/consultation")}
                      >
                        <IconCalendar size={14} style={{ marginRight: "4px" }} />
                        Book Doctor Consultation
                      </button>
                    )}
                  </div>
                )}

                {/* Metadata Chips */}
                {message.role === "assistant" && (message.intent || message.engine) && (
                  <div className="row row--tight" style={{ fontSize: "var(--fs-micro)" }}>
                    {message.intent && <Chip tone="ghost">{fmt.titleCase(message.intent)}</Chip>}
                    {message.engine && <Chip tone="ghost">{message.engine}</Chip>}
                    {message.locale && message.locale !== "en" && <Chip tone="ghost">{message.locale}</Chip>}
                  </div>
                )}

                {/* CBT Cognitive Distortion Insights */}
                {message.distortions && message.distortions.length > 0 && (
                  <Panel tone="info" tight>
                    <span className="label">{t("chat.distortions")}</span>
                    <div className="stack stack-2" style={{ marginTop: "var(--s2)" }}>
                      {message.distortions.map((d) => (
                        <div key={d.key} className="stack stack-1">
                          <strong style={{ fontSize: "var(--fs-tiny)" }}>{d.name}</strong>
                          <p className="meta">{d.correction}</p>
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}

                {/* Doctor Consultation Disclaimer Card on Assistant messages */}
                {message.role === "assistant" && (
                  <div
                    className="row row--between"
                    style={{
                      borderTop: "1px solid var(--border-light, rgba(0,0,0,0.06))",
                      paddingTop: "6px",
                      marginTop: "4px",
                      fontSize: "var(--fs-micro)",
                      color: "var(--ink-dim)",
                    }}
                  >
                    <span className="row row--tight" style={{ alignItems: "center" }}>
                      <IconShield size={12} style={{ color: "var(--signal-ink)" }} />
                      Always consult an ENT physician for clinical diagnosis.
                    </span>
                    <button
                      type="button"
                      className="btn btn--link"
                      style={{ fontSize: "var(--fs-micro)", padding: 0 }}
                      onClick={() => navigate("/results")}
                    >
                      View Clinical Summary
                    </button>
                  </div>
                )}

                {/* Follow-up suggestions */}
                {message.suggestions && message.suggestions.length > 0 && (
                  <div className="row row--tight row--wrap" style={{ marginTop: "var(--s2)" }}>
                    {message.suggestions.map((suggestion) => (
                      <button
                        key={suggestion.label}
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => {
                          if (suggestion.action) {
                            handleAction(suggestion.action);
                          } else {
                            send(suggestion.label);
                          }
                        }}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="msg">
              <span className="msg__avatar">
                <IconSpark size={16} style={{ color: "var(--signal-ink)" }} />
              </span>
              <div className="msg__body">
                <span className="meta">{t("common.thinking")}</span>
              </div>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {/* Input Composer */}
        <div className="chatpanel__compose">
          <form
            className="row row--nowrap"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <input
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask Aura anything about symptoms, causes, treatments, sound therapy, sleep..."
              disabled={busy}
              aria-label={t("chat.messageLabel")}
            />
            <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>
              {t("chat.send")}
            </button>
          </form>
        </div>
      </Panel>

      {/* Educational Knowledge Topics Grid */}
      <TopicRow topics={meta.data?.education_topics ?? []} onAsk={send} />

      {/* Crisis Resources Panel */}
      <CrisisPanel resources={meta.data?.crisis_resources ?? []} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
function contactLink(contact: string): { href: string; external: boolean } | null {
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(contact.trim())) {
    return { href: `https://${contact.trim()}`, external: true };
  }
  const first = contact.split(/\s+or\s+|[,;/]/i)[0].trim();
  const dialable = first.replace(/[^\d+]/g, "");
  return dialable.replace(/\D/g, "").length >= 3 ? { href: `tel:${dialable}`, external: false } : null;
}

function TopicRow({
  topics,
  onAsk,
}: {
  topics: { key: string; title: string; summary: string }[];
  onAsk(text: string): void;
}) {
  const { t } = useTranslation();
  if (topics.length === 0) return null;

  const topicTitle = (topic: { key: string; title: string }) =>
    t(`chat.topicItems.${topic.key}.title`, { defaultValue: topic.title });
  const topicSummary = (topic: { key: string; summary: string }) =>
    t(`chat.topicItems.${topic.key}.summary`, { defaultValue: topic.summary });

  return (
    <Panel bracketed>
      <div className="row row--tight row--nowrap" style={{ marginBottom: "var(--s4)" }}>
        <IconSpark size={16} style={{ color: "var(--signal-ink)", flex: "none" }} />
        <span className="label">{t("chat.topics.title")}</span>
        <span className="meta">{t("chat.topics.tapToAsk")}</span>
      </div>
      <div className="topicrow">
        {topics.map((topic) => (
          <button
            key={topic.key}
            type="button"
            className="topic"
            onClick={() => onAsk(topicTitle(topic))}
            aria-label={t("chat.topics.ask", { title: topicTitle(topic) })}
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="topic__title">{topicTitle(topic)}</span>
              <span className="topic__sub">{topicSummary(topic)}</span>
            </span>
            <IconChevronRight size={15} className="topic__go" />
          </button>
        ))}
      </div>
    </Panel>
  );
}

function CrisisPanel({ resources }: { resources: { region: string; name: string; contact: string }[] }) {
  const { t } = useTranslation();
  if (resources.length === 0) return null;

  return (
    <Panel tone="crit" bracketed>
      <div className="row row--tight row--nowrap" style={{ marginBottom: "var(--s3)" }}>
        <span className="iconbadge iconbadge--sm iconbadge--crit">
          <IconPhone size={15} />
        </span>
        <div style={{ minWidth: 0 }}>
          <span className="label" style={{ color: "var(--crit-ink)" }}>
            {t("chat.crisis.panelTitle")}
          </span>
          <span className="meta" style={{ display: "block" }}>
            {t("chat.crisis.panelSub")}
          </span>
        </div>
      </div>

      <div className="crisisgrid">
        {resources.map((resource) => {
          const link = contactLink(resource.contact);
          return (
            <div key={`${resource.name}-${resource.contact}`} className="crisis-line">
              <span style={{ minWidth: 0 }}>
                <span className="crisis-line__name">
                  {t(`chat.resource.${resource.name}`, { defaultValue: resource.name })}
                </span>
                <span className="crisis-line__region">
                  {t(`chat.region.${resource.region}`, { defaultValue: resource.region })}
                </span>
              </span>
              {link ? (
                <a
                  className="crisis-line__num"
                  href={link.href}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noreferrer" : undefined}
                  aria-label={
                    link.external
                      ? t("chat.crisis.openSite", { name: resource.name })
                      : t("chat.crisis.call", { name: resource.name, contact: resource.contact })
                  }
                >
                  {resource.contact}
                </a>
              ) : (
                <span className="crisis-line__num">
                  {t(`chat.resource.${resource.contact}`, { defaultValue: resource.contact })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="meta" style={{ marginTop: "var(--s3)" }}>
        <Trans i18nKey="chat.crisis.panelFoot" components={[<strong key="0" />]} />
      </p>
    </Panel>
  );
}
