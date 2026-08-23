/**
 * Group Therapy Page for EchoSense AI.
 * 
 * Features:
 * - Patient session creation with Google Meet link & unique permanent 6-character Invite Code.
 * - Join via Invite Code with Host Approval Join Request workflow.
 * - Host Join Request Approval/Rejection interface with real-time polling.
 * - Prominent Google Meet Join header bar with permanent Invite Code display in Copy button.
 * - Leave Room & Delete Room functionality.
 * - Live In-Session Chatbox with Emoji Feelings buttons.
 * - Group Reflection Answers section rendered directly beneath the Live Chatbox.
 * - 4 Interactive Group Therapeutic Activities (Sync Breathing, Mood Radar, Reflection Prompts, Gratitude Wall).
 */

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  api,
  type GroupTherapySession,
  type GroupTherapyMessage,
  type GroupTherapyActivityResponse,
  type GroupTherapyJoinRequest,
  type RehabProgramme as Programme,
  type RehabActivity,
  type Monitoring,
} from "../api/client";
import { useSession } from "../state/session";
import { Loading, Panel, Fader, Meter, Readout, Chip, fmt } from "../components/ui";
import { SpectrumBars } from "../components/charts";
import { RELAXING_SOUNDS } from "../data/relaxingSounds";
import { startTherapy, type TherapyBlock, type TherapyHandle } from "../audio/therapy";
import { engine } from "../audio/engine";

// Emoji Feelings Palette for Quick Reactions
const FEELING_EMOJIS = [
  { emoji: "🧘", label: "Relaxing" },
  { emoji: "😊", label: "Calmer" },
  { emoji: "🌊", label: "Masking On" },
  { emoji: "👂", label: "Ringing High" },
  { emoji: "💆", label: "Relieved" },
  { emoji: "🙏", label: "Grateful" },
  { emoji: "💚", label: "Supported" },
  { emoji: "😴", label: "Sleepy" },
];

export default function GroupTherapy() {
  const toast = useSession((s) => s.toast);

  // Hub & Sessions state
  const [sessions, setSessions] = useState<GroupTherapySession[]>([]);
  const [loadingHub, setLoadingHub] = useState(true);
  const [activeSession, setActiveSession] = useState<GroupTherapySession | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [joiningCode, setJoiningCode] = useState(false);

  // Join Request Workflow state
  const [pendingRequestId, setPendingRequestId] = useState<number | null>(null);
  const [pendingRequests, setPendingRequests] = useState<GroupTherapyJoinRequest[]>([]);
  const [processingRequestId, setProcessingRequestId] = useState<number | null>(null);

  // Delete & Leave state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingRoom, setDeletingRoom] = useState(false);
  const [leavingRoom, setLeavingRoom] = useState(false);

  // Create Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createMeetUrl, setCreateMeetUrl] = useState("");
  const [createMaxCap, setCreateMaxCap] = useState(10);
  const [creating, setCreating] = useState(false);

  // In-Session state
  const [chatMessages, setChatMessages] = useState<GroupTherapyMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [activityResponses, setActivityResponses] = useState<GroupTherapyActivityResponse[]>([]);

  // Therapeutic Activities state
  const [activeTab, setActiveTab] = useState<
    "breathing" | "mood_checkin" | "reflection_prompt" | "gratitude_wall" | "sound_library" | "rehab_programme"
  >("breathing");
  
  // Breathing exercise local animation & audio synthesizer state
  const [breathingPhase, setBreathingPhase] = useState<"Inhale" | "Hold" | "Exhale">("Inhale");
  const [breathingSeconds, setBreathingSeconds] = useState(4);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [soundType, setSoundType] = useState<"notch" | "pink" | "white">("notch");

  // Nature & Relaxing Sounds Sound Therapy State (Aakash's 20 sounds + Web Audio Engine)
  const [selectedSound, setSelectedSound] = useState<TherapyBlock>(RELAXING_SOUNDS[0]);
  const [soundPhase, setSoundPhase] = useState<"idle" | "pre" | "playing" | "post">("idle");
  const [soundLevelDbfs, setSoundLevelDbfs] = useState(-34);
  const [preVas, setPreVas] = useState(5);
  const [postVas, setPostVas] = useState(4);
  const [soundElapsed, setSoundElapsed] = useState(0);
  const [_soundStatus, setSoundStatus] = useState("");
  const [spectrumData, setSpectrumData] = useState<Uint8Array | null>(null);
  const soundHandleRef = useRef<TherapyHandle | null>(null);
  const soundStartedAt = useRef(0);
  const soundFrameRef = useRef(0);

  // Rehab Programme & Monitoring State
  const [rehabData, setRehabData] = useState<Programme | null>(null);
  const [_monitoringData, setMonitoringData] = useState<Monitoring | null>(null);
  const [loadingRehab, setLoadingRehab] = useState(false);
  const [rehabBusy, setRehabBusy] = useState<Set<string>>(new Set());

  // Mood Check-in state
  const [distressRating, setDistressRating] = useState<number>(5);
  const [submittingMood, setSubmittingMood] = useState(false);

  // Reflection Prompt state
  const [reflectionInput, setReflectionInput] = useState("");
  const [submittingReflection, setSubmittingReflection] = useState(false);

  // Gratitude Wall state
  const [gratitudeNote, setGratitudeNote] = useState("");
  const [submittingGratitude, setSubmittingGratitude] = useState(false);

  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioNode | null>(null);

  const stopSoundPlayback = useCallback(() => {
    soundHandleRef.current?.stop(1.2);
    soundHandleRef.current = null;
    cancelAnimationFrame(soundFrameRef.current);
  }, []);

  useEffect(() => {
    return () => {
      stopSoundPlayback();
      engine.stopAll(0.3);
    };
  }, [stopSoundPlayback]);

  useEffect(() => {
    if (soundPhase !== "playing") return;
    const tick = () => {
      setSoundElapsed((performance.now() - soundStartedAt.current) / 1000);
      const buffer = new Uint8Array(1024);
      if (engine.spectrum(buffer)) setSpectrumData(buffer);
      const text = soundHandleRef.current?.status?.();
      if (text) setSoundStatus(text);
      soundFrameRef.current = requestAnimationFrame(tick);
    };
    soundFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(soundFrameRef.current);
  }, [soundPhase]);

  async function startSoundSession() {
    stopSoundPlayback();
    try {
      await engine.resume();
      soundHandleRef.current = startTherapy(selectedSound, soundLevelDbfs);
      soundStartedAt.current = performance.now();
      setSoundPhase("playing");
      setSoundStatus(soundHandleRef.current.status?.() ?? "");
    } catch (err: any) {
      stopSoundPlayback();
      setSoundPhase("pre");
      toast(err.message || "Failed to start sound therapy session", "crit");
    }
  }

  function finishSoundSession() {
    stopSoundPlayback();
    setPostVas(Math.max(0, preVas - 1));
    setSoundPhase("post");
  }

  async function logSoundRelief(completed: boolean) {
    try {
      await api.therapy.logSession({
        modality: selectedSound.modality,
        planned_seconds: selectedSound.minutes * 60,
        actual_seconds: Math.round(soundElapsed),
        completed,
        volume_db: soundLevelDbfs,
        pre_vas_loudness: preVas,
        post_vas_loudness: postVas,
        params: { engine: selectedSound.engine },
      });
      toast(`Logged therapy session! Pre VAS: ${preVas}, Post VAS: ${postVas}`, "ok");
      loadRehabProgress();
    } catch (err: any) {
      toast(err.message || "Failed to log session relief", "crit");
    }
    setSoundPhase("idle");
    setSoundElapsed(0);
  }

  const loadRehabProgress = useCallback(async () => {
    setLoadingRehab(true);
    try {
      const [prog, mon] = await Promise.all([
        api.rehab.programme().catch(() => null),
        api.monitoring.get().catch(() => null),
      ]);
      setRehabData(prog);
      setMonitoringData(mon);
    } catch {
      // silent load
    } finally {
      setLoadingRehab(false);
    }
  }, []);

  useEffect(() => {
    if (activeSession) {
      loadRehabProgress();
    }
  }, [activeSession?.id, loadRehabProgress]);

  async function toggleRehabActivity(activity: RehabActivity) {
    if (rehabBusy.has(activity.key)) return;
    setRehabBusy((prev) => new Set(prev).add(activity.key));
    const isDone = rehabData?.progress.completed_today.includes(activity.key);
    try {
      if (isDone) {
        await api.rehab.undo(activity.key);
      } else {
        await api.rehab.complete(activity.key, activity.minutes);
      }
      await loadRehabProgress();
      toast(`Updated activity: ${activity.key}`, "info");
    } catch (err: any) {
      toast(err.message || "Failed to update activity", "crit");
    } finally {
      setRehabBusy((prev) => {
        const next = new Set(prev);
        next.delete(activity.key);
        return next;
      });
    }
  }

  // Fetch hub sessions on mount
  useEffect(() => {
    loadHubSessions();
  }, []);

  // Poll in-session chat, activities, and host join requests every 3s when inside a session
  useEffect(() => {
    if (!activeSession) return;

    loadSessionDetail(activeSession.id);
    loadSessionChat(activeSession.id);
    if (activeSession.is_host) {
      loadHostJoinRequests(activeSession.id);
    }

    const interval = setInterval(() => {
      loadSessionDetail(activeSession.id, true);
      loadSessionChat(activeSession.id, true);
      if (activeSession.is_host) {
        loadHostJoinRequests(activeSession.id);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeSession?.id, activeSession?.is_host]);

  // Poll pending join request status for guest waiting for host approval
  useEffect(() => {
    if (!pendingRequestId) return;

    const interval = setInterval(async () => {
      try {
        const res = await api.groupTherapy.checkJoinStatus(pendingRequestId);
        if (res.status === "approved" && res.session) {
          toast("Host approved your request! Entering therapy room...", "info");
          setActiveSession(res.session);
          setPendingRequestId(null);
        } else if (res.status === "rejected") {
          toast("Your request to join this session was rejected by the host.", "crit");
          setPendingRequestId(null);
        }
      } catch {
        // silent background check
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [pendingRequestId]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages.length]);

  // Breathing timer cycle
  useEffect(() => {
    if (!activeSession || activeTab !== "breathing") return;
    const timer = setInterval(() => {
      setBreathingSeconds((prev) => {
        if (prev <= 1) {
          setBreathingPhase((phase) => {
            if (phase === "Inhale") return "Hold";
            if (phase === "Hold") return "Exhale";
            return "Inhale";
          });
          return 4;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [activeSession, activeTab]);

  // Sound generator toggle
  function toggleMaskingAudio() {
    if (isAudioPlaying) {
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      setIsAudioPlaying(false);
    } else {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContextClass();
        audioCtxRef.current = ctx;

        const bufferSize = ctx.sampleRate * 2;
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          if (soundType === "pink") {
            const white = Math.random() * 2 - 1;
            output[i] = white * 0.5;
          } else {
            output[i] = Math.random() * 2 - 1;
          }
        }

        const whiteNoise = ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;

        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.08;

        if (soundType === "notch") {
          const filter = ctx.createBiquadFilter();
          filter.type = "notch";
          filter.frequency.value = 4000;
          filter.Q.value = 5.0;
          whiteNoise.connect(filter);
          filter.connect(gainNode);
        } else {
          whiteNoise.connect(gainNode);
        }

        gainNode.connect(ctx.destination);
        whiteNoise.start();
        noiseNodeRef.current = whiteNoise;
        setIsAudioPlaying(true);
      } catch {
        toast("Audio synthesizer failed to start", "crit");
      }
    }
  }

  async function loadHubSessions() {
    setLoadingHub(true);
    try {
      const res = await api.groupTherapy.listSessions();
      setSessions(res.sessions);
    } catch (err: any) {
      toast(err.message || "Failed to load group sessions", "crit");
    } finally {
      setLoadingHub(false);
    }
  }

  async function loadSessionDetail(sessionId: number, silent = false) {
    try {
      const res = await api.groupTherapy.getSession(sessionId);
      setActiveSession(res.session);
      setActivityResponses(res.activity_responses);
      if (!silent) {
        setActiveTab(res.session.current_activity || "breathing");
      }
    } catch {
      // silent background check
    }
  }

  async function loadSessionChat(sessionId: number, _silent = false) {
    try {
      const res = await api.groupTherapy.getChat(sessionId);
      setChatMessages(res.messages);
    } catch {
      // silent poll
    }
  }

  async function loadHostJoinRequests(sessionId: number) {
    try {
      const res = await api.groupTherapy.listRequests(sessionId);
      setPendingRequests(res.requests);
    } catch {
      // silent check
    }
  }

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    if (!createTitle.trim()) {
      toast("Please enter a session title", "crit");
      return;
    }
    setCreating(true);
    try {
      const newSession = await api.groupTherapy.createSession({
        title: createTitle.trim(),
        description: createDesc.trim(),
        meet_url: createMeetUrl.trim(),
        max_participants: createMaxCap,
      });
      toast(`Group Therapy Session created! Permanent Invite Code: ${newSession.invite_code}`, "info");
      setShowCreateModal(false);
      setCreateTitle("");
      setCreateDesc("");
      setCreateMeetUrl("");
      setActiveSession(newSession);
      loadHubSessions();
    } catch (err: any) {
      toast(err.message || "Failed to create session", "crit");
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinByCode(e: React.FormEvent) {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    setJoiningCode(true);
    try {
      const res = await api.groupTherapy.requestJoin(joinCodeInput.trim().toUpperCase());
      if (res.status === "approved" && res.session) {
        toast(`Entered room: ${res.session.title}`, "info");
        setActiveSession(res.session);
      } else if (res.status === "pending" && res.request_id) {
        toast("Join request sent! Waiting for room host approval...", "info");
        setPendingRequestId(res.request_id);
      }
      setJoinCodeInput("");
      loadHubSessions();
    } catch (err: any) {
      toast(err.message || "Invalid invite code or session closed", "crit");
    } finally {
      setJoiningCode(false);
    }
  }

  async function handleEnterRoomCard(sess: GroupTherapySession) {
    if (sess.is_host || sess.is_participant) {
      setActiveSession(sess);
      toast(`Entered room: ${sess.title}`, "info");
      return;
    }

    setJoiningCode(true);
    try {
      const res = await api.groupTherapy.requestJoin(sess.invite_code);
      if (res.status === "approved" && res.session) {
        toast(`Entered room: ${res.session.title}`, "info");
        setActiveSession(res.session);
      } else if (res.status === "pending" && res.request_id) {
        toast(`Join request sent to host (${sess.host_name})! Waiting for approval...`, "info");
        setPendingRequestId(res.request_id);
      } else if (res.status === "rejected") {
        toast("Your request to join this session was rejected by the host.", "crit");
      }
      loadHubSessions();
    } catch (err: any) {
      toast(err.message || "Failed to send join request", "crit");
    } finally {
      setJoiningCode(false);
    }
  }

  async function handleRespondRequest(requestId: number, action: "approve" | "reject") {
    if (!activeSession) return;
    setProcessingRequestId(requestId);
    try {
      await api.groupTherapy.respondRequest(activeSession.id, requestId, action);
      toast(action === "approve" ? "Approved patient join request!" : "Rejected join request.", "info");
      loadHostJoinRequests(activeSession.id);
      loadSessionDetail(activeSession.id, true);
    } catch (err: any) {
      toast(err.message || "Failed to process join request", "crit");
    } finally {
      setProcessingRequestId(null);
    }
  }

  async function handleLeaveRoom() {
    if (!activeSession) return;
    setLeavingRoom(true);
    try {
      await api.groupTherapy.leaveSession(activeSession.id);
      toast("You left the therapy session room.", "info");
      setActiveSession(null);
      loadHubSessions();
    } catch (err: any) {
      toast(err.message || "Failed to leave session", "crit");
    } finally {
      setLeavingRoom(false);
    }
  }

  async function handleDeleteRoom() {
    if (!activeSession) return;
    setDeletingRoom(true);
    try {
      await api.groupTherapy.deleteSession(activeSession.id);
      toast(`Session room '${activeSession.title}' was deleted.`, "info");
      setShowDeleteModal(false);
      setActiveSession(null);
      loadHubSessions();
    } catch (err: any) {
      toast(err.message || "Failed to delete room", "crit");
    } finally {
      setDeletingRoom(false);
    }
  }

  async function handleSendChat(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!activeSession || !chatInput.trim() || sendingChat) return;

    const contentToSend = chatInput.trim();
    setChatInput("");
    setSendingChat(true);

    try {
      const msg = await api.groupTherapy.sendChat(activeSession.id, contentToSend);
      setChatMessages((prev) => [...prev, msg]);
    } catch (err: any) {
      toast(err.message || "Failed to send message", "crit");
    } finally {
      setSendingChat(false);
    }
  }

  async function handleSendEmojiReaction(emoji: string) {
    if (!activeSession) return;
    try {
      const msg = await api.groupTherapy.sendChat(
        activeSession.id,
        `is feeling ${emoji}`,
        emoji,
        "feeling_emoji"
      );
      setChatMessages((prev) => [...prev, msg]);
      toast(`Shared feeling ${emoji}`, "info");
    } catch {
      toast("Failed to share feeling emoji", "crit");
    }
  }

  async function handleSubmitMood() {
    if (!activeSession) return;
    setSubmittingMood(true);
    try {
      await api.groupTherapy.submitActivity(activeSession.id, "mood_checkin", {
        distress_level: distressRating,
      });
      toast("Distress & Mood check-in logged!", "info");
      loadSessionDetail(activeSession.id, true);
    } catch (err: any) {
      toast(err.message || "Failed to submit check-in", "crit");
    } finally {
      setSubmittingMood(false);
    }
  }

  async function handleSubmitReflection(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSession || !reflectionInput.trim()) return;
    setSubmittingReflection(true);
    try {
      await api.groupTherapy.submitActivity(activeSession.id, "reflection_prompt", {
        text: reflectionInput.trim(),
      });
      setReflectionInput("");
      toast("Reflection answer posted! Look under the Chat box below to view all responses.", "info");
      loadSessionDetail(activeSession.id, true);
    } catch (err: any) {
      toast(err.message || "Failed to post reflection", "crit");
    } finally {
      setSubmittingReflection(false);
    }
  }

  async function handleSubmitGratitude(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSession || !gratitudeNote.trim()) return;
    setSubmittingGratitude(true);
    try {
      await api.groupTherapy.submitActivity(activeSession.id, "gratitude_wall", {
        note: gratitudeNote.trim(),
      });
      setGratitudeNote("");
      toast("Encouragement note posted to wall!", "info");
      loadSessionDetail(activeSession.id, true);
    } catch (err: any) {
      toast(err.message || "Failed to post gratitude note", "crit");
    } finally {
      setSubmittingGratitude(false);
    }
  }

  function copyInviteCode(code: string) {
    navigator.clipboard.writeText(code);
    toast(`Invite code ${code} copied to clipboard!`, "info");
  }

  // Filter reflection answers for displaying under chat
  const reflectionAnswers = activityResponses.filter((r) => r.activity_type === "reflection_prompt");

  // Calculate mood check-in room average
  const moodResponses = activityResponses.filter((r) => r.activity_type === "mood_checkin");
  const avgDistress = moodResponses.length
    ? (
        moodResponses.reduce((acc, r) => acc + Number(r.response_data.distress_level || 5), 0) /
        moodResponses.length
      ).toFixed(1)
    : "5.0";

  return (
    <div className="wrap stack stack-6" style={{ paddingBottom: "var(--s8)" }}>
      {/* Top Banner */}
      <div className="panel row row--between row--wrap" style={{ background: "linear-gradient(135deg, rgba(30,58,138,0.2) 0%, rgba(15,23,42,0.6) 100%)", borderColor: "rgba(59,130,246,0.3)" }}>
        <div>
          <span className="label label--signal">PATIENT PEER SUPPORT</span>
          <h1 style={{ marginTop: "var(--s1)", fontSize: "var(--fs-headline-lg)" }}>Group Therapy Sessions</h1>
          <p className="meta" style={{ maxWidth: "600px" }}>
            Connect with fellow patients in real-time group therapy sessions. Share coping strategies, join Google Meet calls, and participate in guided group sound exercises.
          </p>
        </div>

        <div className="row row--tight" style={{ alignSelf: "center" }}>
          {activeSession && (
            <button
              type="button"
              className="btn btn--outline"
              onClick={() => setActiveSession(null)}
            >
              ← Back to Hub
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowCreateModal(true)}
          >
            + Create Group Session
          </button>
        </div>
      </div>

      {/* GUEST WAITING FOR HOST APPROVAL SCREEN */}
      {pendingRequestId && !activeSession && (
        <div className="panel stack stack-4" style={{ textAlign: "center", padding: "var(--s6)", background: "var(--surface-elevated)", border: "2px dashed var(--accent)" }}>
          <div style={{ fontSize: "3rem" }}>⏳</div>
          <h2 style={{ margin: 0 }}>Join Request Sent!</h2>
          <p className="meta" style={{ maxWidth: "500px", margin: "0 auto" }}>
            Your request to join the group therapy room has been sent to the room host. Please wait while the host approves your entry.
          </p>

          <div className="row row--tight" style={{ justifyContent: "center", gap: "var(--s2)", marginTop: "var(--s2)" }}>
            <span className="chip chip--ok">● Polling Host Approval</span>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => setPendingRequestId(null)}
            >
              Cancel Request
            </button>
          </div>
        </div>
      )}

      {/* HUB VIEW (If no active room selected and not waiting for approval) */}
      {!activeSession && !pendingRequestId && (
        <div className="stack stack-6">
          {/* Join Code Quick Action Card */}
          <div className="panel" style={{ background: "var(--surface-elevated)" }}>
            <h3 style={{ marginBottom: "var(--s2)" }}>Have an Invite Code?</h3>
            <form onSubmit={handleJoinByCode} className="row row--tight row--wrap">
              <input
                type="text"
                placeholder="Enter 6-character code (e.g. GT-89X2)"
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                className="input"
                style={{
                  maxWidth: "320px",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  fontWeight: "bold",
                  background: "rgba(15, 23, 42, 0.95)",
                  color: "#f8fafc",
                  border: "1px solid rgba(148, 163, 184, 0.4)",
                }}
              />
              <button type="submit" className="btn btn--primary" disabled={joiningCode || !joinCodeInput.trim()}>
                {joiningCode ? "Sending Request..." : "Request to Join Group Session"}
              </button>
            </form>
          </div>

          {/* Active Sessions List */}
          <div>
            <h2>Active Group Therapy Rooms</h2>
            <p className="meta">Join an ongoing patient therapy room or request access from the host.</p>

            {loadingHub ? (
              <Loading label="Loading group therapy sessions..." />
            ) : sessions.length === 0 ? (
              <div className="panel" style={{ textAlign: "center", padding: "var(--s6)" }}>
                <p className="meta">No active group sessions right now.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--s4)", marginTop: "var(--s3)" }}>
                {sessions.map((sess) => (
                  <div key={sess.id} className="panel stack stack-3" style={{ borderLeft: "4px solid var(--accent)" }}>
                    <div className="row row--between">
                      <span className="chip chip--ok">● LIVE ROOM</span>
                      <span className="meta">{sess.participant_count} / {sess.max_participants} Patients</span>
                    </div>

                    <h3 style={{ margin: 0 }}>{sess.title}</h3>
                    {sess.description && <p className="meta" style={{ fontSize: "var(--fs-small)" }}>{sess.description}</p>}

                    <div className="row row--between" style={{ marginTop: "var(--s2)" }}>
                      <span className="meta">Host: {sess.host_name}</span>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={joiningCode}
                        onClick={() => handleEnterRoomCard(sess)}
                      >
                        {sess.is_host || sess.is_participant ? "Enter Room →" : "Request to Join →"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ACTIVE SESSION ROOM VIEW */}
      {activeSession && (
        <div className="stack stack-6">
          {/* Prominent Active Room Banner with Sleek Gray Background */}
          <div
            className="panel row row--between row--wrap"
            style={{
              background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <div className="stack stack-1">
              <div className="row row--tight">
                <span className="chip" style={{ background: "#10b981", color: "#ffffff", fontWeight: "bold" }}>
                  ROOM ACTIVE
                </span>
                <span className="chip" style={{ background: "rgba(255, 255, 255, 0.15)", color: "#ffffff", fontWeight: "600" }}>
                  {activeSession.participant_count} Patients In Room
                </span>
                {activeSession.is_host && (
                  <span className="chip" style={{ background: "#f59e0b", color: "#0f172a", fontWeight: "bold" }}>
                    YOU ARE HOST
                  </span>
                )}
              </div>
              <h2 style={{ color: "#ffffff", margin: "var(--s1) 0 0 0" }}>{activeSession.title}</h2>
              <p className="meta" style={{ color: "#cbd5e1" }}>
                Hosted by {activeSession.host_name} | Permanent Invite Code: <strong style={{ color: "#f8fafc" }}>{activeSession.invite_code}</strong>
              </p>
            </div>

            <div className="row row--tight" style={{ alignSelf: "center", gap: "var(--s3)" }}>
              {/* Permanent Invite Code displayed inside Copy button */}
              <button
                type="button"
                className="btn"
                onClick={() => copyInviteCode(activeSession.invite_code)}
                style={{
                  background: "#ffffff",
                  color: "#0f172a",
                  fontWeight: "800",
                  border: "1px solid #cbd5e1",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                  padding: "var(--s2) var(--s4)",
                }}
              >
                📋 Copy Code: <span style={{ color: "#0284c7", fontWeight: "900", letterSpacing: "1px", marginLeft: "4px" }}>{activeSession.invite_code}</span>
              </button>

              {activeSession.meet_url && (
                <a
                  href={activeSession.meet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--primary"
                  style={{
                    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                    fontWeight: "bold",
                    fontSize: "var(--fs-medium)",
                    padding: "var(--s2) var(--s4)",
                  }}
                >
                  🎥 Join Google Meet Video Call ↗
                </a>
              )}

              {/* Leave Room Button */}
              <button
                type="button"
                className="btn"
                onClick={handleLeaveRoom}
                disabled={leavingRoom}
                style={{
                  background: "#ffffff",
                  color: "#b91c1c",
                  fontWeight: "bold",
                  border: "1px solid #fca5a5",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
                }}
              >
                {leavingRoom ? "Leaving..." : "🚪 Leave Room"}
              </button>

              {/* Delete Room Button (Host Only) */}
              {activeSession.is_host && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setShowDeleteModal(true)}
                  style={{ background: "#dc2626", borderColor: "#b91c1c", color: "#ffffff", fontWeight: "bold" }}
                >
                  🗑️ Delete Room
                </button>
              )}
            </div>
          </div>

          {/* HOST PENDING JOIN REQUESTS BANNER */}
          {activeSession.is_host && pendingRequests.length > 0 && (
            <div className="panel stack stack-3" style={{ background: "linear-gradient(135deg, rgba(217, 119, 6, 0.2) 0%, rgba(180, 83, 9, 0.4) 100%)", borderColor: "#f59e0b" }}>
              <div className="row row--between">
                <div className="row row--tight">
                  <span className="chip chip--warn">PENDING REQUESTS</span>
                  <strong style={{ fontSize: "var(--fs-medium)", color: "#fef3c7" }}>
                    {pendingRequests.length} Patient(s) requesting to join this group therapy session:
                  </strong>
                </div>
              </div>

              <div className="stack stack-2">
                {pendingRequests.map((req) => (
                  <div key={req.id} className="panel row row--between" style={{ background: "rgba(15, 23, 42, 0.8)", padding: "var(--s2) var(--s3)" }}>
                    <span style={{ fontWeight: 600, color: "#fff" }}>👤 {req.user_name}</span>
                    <div className="row row--tight" style={{ gap: "var(--s2)" }}>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={processingRequestId === req.id}
                        onClick={() => handleRespondRequest(req.id, "approve")}
                        style={{ background: "#10b981", borderColor: "#059669" }}
                      >
                        ✓ Approve (Admit)
                      </button>
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        disabled={processingRequestId === req.id}
                        onClick={() => handleRespondRequest(req.id, "reject")}
                        style={{ borderColor: "#ef4444", color: "#fca5a5" }}
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Room Main Split Layout */}
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "var(--s6)", alignItems: "start" }}>
            
            {/* LEFT COLUMN: LIVE CHATBOX + REFLECTION ANSWERS DISPLAY */}
            <div className="stack stack-4">
              {/* Chatbox Container */}
              <div
                className="panel stack stack-3"
                style={{
                  height: "450px",
                  display: "flex",
                  flexDirection: "column",
                  border: "2px solid rgba(99, 102, 241, 0.5)",
                  boxShadow: "0 0 20px rgba(99, 102, 241, 0.15)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <div className="row row--between" style={{ borderBottom: "1px solid var(--border)", paddingBottom: "var(--s2)" }}>
                  <div>
                    <h3 style={{ margin: 0 }}>Room Chat & Reactions</h3>
                    <span className="meta" style={{ fontSize: "var(--fs-xs)" }}>Live messages & feelings</span>
                  </div>
                  <span className="chip chip--neutral">● Polling</span>
                </div>

                {/* Chat Message Stream */}
                <div
                  ref={chatScrollRef}
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--s2)",
                    paddingRight: "var(--s2)",
                  }}
                >
                  {chatMessages.length === 0 ? (
                    <p className="meta" style={{ textAlign: "center", margin: "auto" }}>
                      No chat messages yet. Say hello or share your feeling!
                    </p>
                  ) : (
                    chatMessages.map((msg) => {
                      const isSystem = msg.message_type === "system";
                      const isEmoji = msg.message_type === "feeling_emoji";

                      if (isSystem) {
                        return (
                          <div
                            key={msg.id}
                            style={{
                              textAlign: "center",
                              fontSize: "var(--fs-xs)",
                              color: "var(--text-meta)",
                              background: "rgba(255,255,255,0.03)",
                              padding: "4px 8px",
                              borderRadius: "var(--radius-sm)",
                              margin: "4px 0",
                            }}
                          >
                            ℹ️ {msg.content}
                          </div>
                        );
                      }

                      return (
                        <div
                          key={msg.id}
                          style={{
                            alignSelf: msg.is_own_message ? "flex-end" : "flex-start",
                            maxWidth: "85%",
                            background: msg.is_own_message
                              ? "var(--ink)"
                              : "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
                            color: "#ffffff",
                            border: msg.is_own_message
                              ? "1px solid rgba(255, 255, 255, 0.2)"
                              : "1px solid rgba(148, 163, 184, 0.25)",
                            boxShadow: msg.is_own_message
                              ? "0 3px 12px rgba(0, 0, 0, 0.3)"
                              : "0 2px 8px rgba(0, 0, 0, 0.2)",
                            padding: "var(--s2) var(--s3)",
                            borderRadius: "var(--radius-md)",
                            borderBottomRightRadius: msg.is_own_message ? "2px" : "var(--radius-md)",
                            borderBottomLeftRadius: msg.is_own_message ? "var(--radius-md)" : "2px",
                          }}
                        >
                          <div className="row row--between" style={{ gap: "var(--s3)", marginBottom: "2px" }}>
                            <strong style={{ fontSize: "var(--fs-xs)", color: msg.is_own_message ? "#ffffff" : "#38bdf8" }}>
                              {msg.is_own_message ? "You" : msg.sender_name}
                            </strong>
                            <span className="meta" style={{ fontSize: "10px", color: msg.is_own_message ? "rgba(255, 255, 255, 0.7)" : "#94a3b8" }}>
                              {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>

                          {isEmoji ? (
                            <div className="row row--tight" style={{ marginTop: "4px" }}>
                              <span style={{ fontSize: "1.6rem" }}>{msg.emoji_reaction}</span>
                              <span style={{ fontSize: "var(--fs-small)", fontStyle: "italic", color: "#ffffff" }}>{msg.content}</span>
                            </div>
                          ) : (
                            <div style={{ fontSize: "var(--fs-small)", wordBreak: "break-word", color: "#ffffff", lineHeight: "1.45" }}>{msg.content}</div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Quick Feelings Emoji Row */}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--s2)" }}>
                  <span className="meta" style={{ fontSize: "11px", display: "block", marginBottom: "4px" }}>
                    Express how you are feeling to the group:
                  </span>
                  <div style={{ display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "4px" }}>
                    {FEELING_EMOJIS.map((f) => (
                      <button
                        key={f.emoji}
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => handleSendEmojiReaction(f.emoji)}
                        title={`Send ${f.label}`}
                        style={{ padding: "4px 8px", background: "rgba(255,255,255,0.05)", borderRadius: "var(--radius-sm)" }}
                      >
                        <span>{f.emoji}</span>
                        <span style={{ fontSize: "10px", marginLeft: "4px" }}>{f.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Chat Input Form */}
                <form onSubmit={handleSendChat} className="row row--tight" style={{ marginTop: "var(--s2)" }}>
                  <input
                    type="text"
                    placeholder="Type a message to the group..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    className="input"
                    style={{
                      flex: 1,
                      background: "rgba(15, 23, 42, 0.95)",
                      color: "#f8fafc",
                      border: "1px solid rgba(148, 163, 184, 0.4)",
                    }}
                  />
                  <button type="submit" className="btn btn--primary" disabled={sendingChat || !chatInput.trim()}>
                    Send
                  </button>
                </form>
              </div>

              {/* GROUP REFLECTION ANSWERS DISPLAYED UNDER CHAT BOX */}
              <div className="panel stack stack-3" style={{ background: "var(--surface-elevated)", borderLeft: "4px solid #8b5cf6" }}>
                <div className="row row--between">
                  <div className="row row--tight">
                    <span style={{ fontSize: "1.2rem" }}>💡</span>
                    <h3 style={{ margin: 0 }}>Group Reflection Answers</h3>
                  </div>
                  <span className="chip chip--neutral">{reflectionAnswers.length} Responses</span>
                </div>
                <p className="meta" style={{ fontSize: "var(--fs-xs)", margin: 0 }}>
                  Answers posted by group participants for: <em>"{activeSession.activity_data?.prompt || "What sound therapy technique worked best for you today?"}"</em>
                </p>

                <div style={{ maxHeight: "250px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
                  {reflectionAnswers.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "var(--s3)", color: "var(--text-meta)", fontStyle: "italic", fontSize: "var(--fs-small)" }}>
                      No reflection answers posted yet. Go to tab "3. Reflection" on the right and click Post to share your reflection!
                    </div>
                  ) : (
                    reflectionAnswers.map((r) => (
                      <div key={r.id} className="panel stack stack-1" style={{ background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(139, 92, 246, 0.3)" }}>
                        <div className="row row--between">
                          <strong style={{ fontSize: "var(--fs-xs)", color: "#a78bfa" }}>👤 {r.user_name}</strong>
                          <span className="meta" style={{ fontSize: "10px", opacity: 0.7 }}>
                            {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p style={{ margin: "4px 0 0 0", fontSize: "var(--fs-small)", color: "#f8fafc", lineHeight: "1.4" }}>
                          "{r.response_data.text}"
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>

            {/* RIGHT COLUMN: INTERACTIVE GROUP THERAPEUTIC ACTIVITIES */}
            <div className="panel stack stack-4" style={{ minHeight: "650px" }}>
              <div>
                <h2>Group Therapeutic Activities</h2>
                <p className="meta">Synchronized exercises designed to relieve tinnitus stress & build peer strength.</p>
              </div>

              {/* Activity Tabs */}
              <div className="row row--tight row--wrap" style={{ borderBottom: "1px solid var(--border)", paddingBottom: "var(--s2)", gap: "6px" }}>
                <button
                  type="button"
                  className={`btn ${activeTab === "breathing" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("breathing")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  🫁 1. Sync Breathing
                </button>
                <button
                  type="button"
                  className={`btn ${activeTab === "mood_checkin" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("mood_checkin")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  📊 2. Mood Radar
                </button>
                <button
                  type="button"
                  className={`btn ${activeTab === "reflection_prompt" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("reflection_prompt")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  💡 3. Reflection
                </button>
                <button
                  type="button"
                  className={`btn ${activeTab === "gratitude_wall" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("gratitude_wall")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  💌 4. Gratitude Wall
                </button>
                <button
                  type="button"
                  className={`btn ${activeTab === "sound_library" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("sound_library")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  🎵 5. Sound Therapy
                </button>
                <button
                  type="button"
                  className={`btn ${activeTab === "rehab_programme" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => setActiveTab("rehab_programme")}
                  style={{ fontSize: "var(--fs-xs)" }}
                >
                  📈 6. Rehab Progress
                </button>
              </div>

              {/* TAB 1: SYNCHRONIZED BREATHING & SOUNDSCAPE */}
              {activeTab === "breathing" && (
                <div className="stack stack-4" style={{ textAlign: "center" }}>
                  <div className="panel" style={{ background: "rgba(15,23,42,0.8)", padding: "var(--s6)", borderRadius: "var(--radius-md)" }}>
                    <span className="label label--signal">GUIDED BREATHING CIRCLE</span>

                    {/* Animated Breathing Sphere */}
                    <div
                      style={{
                        width: "160px",
                        height: "160px",
                        borderRadius: "50%",
                        margin: "var(--s4) auto",
                        background:
                          breathingPhase === "Inhale"
                            ? "radial-gradient(circle, rgba(59,130,246,0.8) 0%, rgba(37,99,235,0.2) 70%)"
                            : breathingPhase === "Hold"
                            ? "radial-gradient(circle, rgba(16,185,129,0.8) 0%, rgba(5,150,105,0.2) 70%)"
                            : "radial-gradient(circle, rgba(139,92,246,0.8) 0%, rgba(124,58,237,0.2) 70%)",
                        boxShadow: "0 0 40px rgba(59,130,246,0.4)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "all 1s ease-in-out",
                        transform: breathingPhase === "Inhale" ? "scale(1.15)" : breathingPhase === "Hold" ? "scale(1.15)" : "scale(0.85)",
                      }}
                    >
                      <strong style={{ fontSize: "var(--fs-headline-sm)", color: "#fff" }}>{breathingPhase}</strong>
                      <span style={{ fontSize: "var(--fs-medium)", color: "rgba(255,255,255,0.8)" }}>{breathingSeconds}s</span>
                    </div>

                    <p className="meta">Breathe in sync with your group to calm auditory nerve hyper-reactivity.</p>
                  </div>

                  {/* Sound Masking Synthesizer */}
                  <div className="panel stack stack-3" style={{ textAlign: "left" }}>
                    <h3>Group Tinnitus Masking Synthesizer</h3>
                    <p className="meta">Play background acoustic masking while doing group activities.</p>

                    <div className="row row--between row--wrap">
                      <div className="row row--tight">
                        <label className="meta">Sound Masker:</label>
                        <select
                          value={soundType}
                          onChange={(e) => setSoundType(e.target.value as any)}
                          className="input"
                          style={{
                            maxWidth: "160px",
                            background: "rgba(15, 23, 42, 0.95)",
                            color: "#f8fafc",
                            border: "1px solid rgba(148, 163, 184, 0.4)",
                          }}
                        >
                          <option value="notch">Notch Noise Filter</option>
                          <option value="pink">Pink Soundscape</option>
                          <option value="white">Broadband White</option>
                        </select>
                      </div>

                      <button
                        type="button"
                        className={`btn ${isAudioPlaying ? "btn--outline" : "btn--primary"}`}
                        onClick={toggleMaskingAudio}
                      >
                        {isAudioPlaying ? "🔇 Stop Masking Sound" : "🔊 Play Masking Sound"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: MOOD & DISTRESS RADAR */}
              {activeTab === "mood_checkin" && (
                <div className="stack stack-4">
                  <div className="panel stack stack-3" style={{ background: "var(--surface-elevated)" }}>
                    <h3>Room Tinnitus Distress Average: <span style={{ color: "var(--accent)" }}>{avgDistress} / 10</span></h3>
                    <p className="meta">Submit your current distress level to calculate room statistics anonymously.</p>

                    <div className="stack stack-2" style={{ marginTop: "var(--s2)" }}>
                      <label className="row row--between">
                        <span>Your Current Tinnitus Distress (1 = Peaceful, 10 = Severe):</span>
                        <strong>{distressRating} / 10</strong>
                      </label>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        value={distressRating}
                        onChange={(e) => setDistressRating(Number(e.target.value))}
                        style={{ width: "100%", accentColor: "var(--accent)" }}
                      />
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={handleSubmitMood}
                        disabled={submittingMood}
                        style={{ marginTop: "var(--s2)", alignSelf: "flex-start" }}
                      >
                        {submittingMood ? "Logging..." : "Log My Check-in"}
                      </button>
                    </div>
                  </div>

                  {/* Room Check-in History */}
                  <div>
                    <h4>Recent Room Check-ins ({moodResponses.length})</h4>
                    <div style={{ maxHeight: "250px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                      {moodResponses.length === 0 ? (
                        <p className="meta">No mood check-ins logged yet for this session.</p>
                      ) : (
                        moodResponses.map((r) => (
                          <div key={r.id} className="row row--between panel" style={{ padding: "var(--s2) var(--s3)" }}>
                            <span>{r.user_name}</span>
                            <span className="chip chip--ok">Distress: {r.response_data.distress_level} / 10</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: REFLECTION PROMPT */}
              {activeTab === "reflection_prompt" && (
                <div className="stack stack-4">
                  <div className="panel stack stack-3" style={{ borderLeft: "4px solid #8b5cf6" }}>
                    <span className="label label--signal">SESSION REFLECTION PROMPT</span>
                    <h3 style={{ margin: 0 }}>
                      "{activeSession.activity_data?.prompt || "What sound therapy technique worked best for you today?"}"
                    </h3>
                  </div>

                  {/* Submission Form */}
                  <form onSubmit={handleSubmitReflection} className="stack stack-2">
                    <textarea
                      rows={3}
                      placeholder="Share your reflection or advice with fellow patients... (Will display under Chat box)"
                      value={reflectionInput}
                      onChange={(e) => setReflectionInput(e.target.value)}
                      className="input"
                      style={{
                        background: "rgba(15, 23, 42, 0.95)",
                        color: "#f8fafc",
                        border: "1px solid rgba(148, 163, 184, 0.4)",
                      }}
                    />
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={submittingReflection || !reflectionInput.trim()}
                      style={{ alignSelf: "flex-end", fontWeight: "bold" }}
                    >
                      {submittingReflection ? "Posting..." : "Post Answer"}
                    </button>
                  </form>
                </div>
              )}

              {/* TAB 4: GRATITUDE & ENCOURAGEMENT WALL */}
              {activeTab === "gratitude_wall" && (
                <div className="stack stack-4">
                  <div>
                    <h3>Encouragement & Gratitude Wall</h3>
                    <p className="meta">Post virtual sticky notes of strength and positivity to support group members.</p>
                  </div>

                  <form onSubmit={handleSubmitGratitude} className="row row--tight">
                    <input
                      type="text"
                      placeholder="Post a note (e.g. You are stronger than your tinnitus! 💚)"
                      value={gratitudeNote}
                      onChange={(e) => setGratitudeNote(e.target.value)}
                      className="input"
                      style={{
                        flex: 1,
                        background: "rgba(15, 23, 42, 0.95)",
                        color: "#f8fafc",
                        border: "1px solid rgba(148, 163, 184, 0.4)",
                      }}
                    />
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={submittingGratitude || !gratitudeNote.trim()}
                    >
                      Post Note
                    </button>
                  </form>

                  {/* Wall Sticky Notes Grid */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                      gap: "var(--s3)",
                      maxHeight: "320px",
                      overflowY: "auto",
                      paddingRight: "4px",
                    }}
                  >
                    {activityResponses.filter((r) => r.activity_type === "gratitude_wall").length === 0 ? (
                      <p className="meta" style={{ gridColumn: "1 / -1" }}>No notes on the wall yet. Leave a kind message!</p>
                    ) : (
                      activityResponses
                        .filter((r) => r.activity_type === "gratitude_wall")
                        .map((r, idx) => {
                          const colors = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#e9d5ff"];
                          const noteBg = colors[idx % colors.length];
                          return (
                            <div
                              key={r.id}
                              style={{
                                background: noteBg,
                                color: "#0f172a",
                                padding: "var(--s3)",
                                borderRadius: "var(--radius-sm)",
                                boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                                display: "flex",
                                flexDirection: "column",
                                justifyContent: "space-between",
                                minHeight: "100px",
                              }}
                            >
                              <p style={{ margin: 0, fontWeight: 500, fontSize: "var(--fs-small)" }}>"{r.response_data.note}"</p>
                              <span style={{ fontSize: "10px", fontWeight: "bold", textAlign: "right", marginTop: "8px", opacity: 0.8 }}>
                                — {r.user_name}
                              </span>
                            </div>
                          );
                        })
                    )}
                  </div>
                </div>
              )}

              {/* TAB 5: GROUP NATURE & RELAXING SOUND THERAPY (AAKASH'S 20 SOUNDS + WEB AUDIO ENGINE) */}
              {activeTab === "sound_library" && (
                <div className="stack stack-4">
                  <div className="panel stack stack-3" style={{ background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(148, 163, 184, 0.3)" }}>
                    <div className="row row--between">
                      <div>
                        <h3 style={{ margin: 0, color: "#fff" }}>Group Nature & Relaxing Soundscapes</h3>
                        <p className="meta" style={{ color: "#cbd5e1" }}>
                          20 live synthesized soundscapes for acoustic masking and relaxation during group sessions.
                        </p>
                      </div>
                      <Chip tone="info">20 Preset Sounds</Chip>
                    </div>

                    {/* Sound Selector Dropdown */}
                    <div className="stack stack-2">
                      <label className="meta" style={{ color: "#fff", fontWeight: 600 }}>Select Relaxing Soundscape:</label>
                      <select
                        value={selectedSound.id}
                        onChange={(e) => {
                          const found = RELAXING_SOUNDS.find((s) => s.id === e.target.value);
                          if (found) setSelectedSound(found);
                        }}
                        className="input"
                        style={{
                          width: "100%",
                          background: "rgba(15, 23, 42, 0.95)",
                          color: "#ffffff",
                          border: "1px solid rgba(148, 163, 184, 0.4)",
                          padding: "10px",
                        }}
                      >
                        {RELAXING_SOUNDS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title} ({s.engine} · {s.minutes}m)
                          </option>
                        ))}
                      </select>
                      <p className="meta" style={{ color: "#94a3b8", fontSize: "var(--fs-xs)" }}>
                        {selectedSound.goal}
                      </p>
                    </div>

                    {/* Audio Player Controls */}
                    <div className="panel stack stack-3" style={{ background: "rgba(30, 41, 59, 0.7)", borderColor: "rgba(99, 102, 241, 0.3)" }}>
                      <div className="row row--between">
                        <strong style={{ color: "#fff" }}>{selectedSound.title}</strong>
                        <Chip tone={soundPhase === "playing" ? "signal" : "ghost"}>
                          {soundPhase === "playing" ? "Playing Live" : "Idle"}
                        </Chip>
                      </div>

                      {soundPhase === "playing" && (
                        <div className="stack stack-3">
                          <div className="row row--between">
                            <Readout
                              label="Elapsed Time"
                              value={`${Math.floor(soundElapsed / 60)}:${String(Math.floor(soundElapsed % 60)).padStart(2, "0")}`}
                              size="sm"
                              tone="signal"
                            />
                            <Readout label="Target" value={selectedSound.minutes} unit="min" size="sm" />
                          </div>

                          <div>
                            <span className="label" style={{ color: "#cbd5e1", marginBottom: "4px", display: "block" }}>
                              Live Spectrum Output
                            </span>
                            <SpectrumBars data={spectrumData} height={50} bars={40} />
                          </div>

                          <Fader
                            label="Volume (dBFS)"
                            value={soundLevelDbfs}
                            min={-60}
                            max={-8}
                            step={1}
                            unit="dBFS"
                            onChange={(val) => {
                              setSoundLevelDbfs(val);
                              soundHandleRef.current?.setLevelDb(val, 0.25);
                            }}
                            lowLabel="Quieter"
                            highLabel="Louder"
                          />
                        </div>
                      )}

                      {/* Pre / Post Rating & Play Buttons */}
                      {soundPhase === "idle" && (
                        <div className="stack stack-2">
                          <div className="row row--between">
                            <span className="meta" style={{ color: "#e2e8f0" }}>Pre-Session Loudness (0 - 10):</span>
                            <span className="mono" style={{ color: "#38bdf8", fontWeight: "bold" }}>{preVas} / 10</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={10}
                            step={0.5}
                            value={preVas}
                            onChange={(e) => setPreVas(Number(e.target.value))}
                            style={{ width: "100%", accentColor: "var(--accent)" }}
                          />
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={startSoundSession}
                            style={{ fontWeight: "bold", marginTop: "8px" }}
                          >
                            ▶ Start Group Sound Session ({selectedSound.minutes}m)
                          </button>
                        </div>
                      )}

                      {soundPhase === "playing" && (
                        <div className="row row--between" style={{ marginTop: "8px" }}>
                          <button
                            type="button"
                            className="btn btn--outline"
                            onClick={finishSoundSession}
                            style={{ borderColor: "#f87171", color: "#fca5a5" }}
                          >
                            ⏹ Finish Session & Rate Relief
                          </button>
                        </div>
                      )}

                      {soundPhase === "post" && (
                        <div className="stack stack-3" style={{ background: "rgba(15, 23, 42, 0.9)", padding: "12px", borderRadius: "8px" }}>
                          <h4 style={{ color: "#fff", margin: 0 }}>Rate Post-Session Tinnitus Loudness</h4>
                          <div className="row row--between">
                            <span className="meta" style={{ color: "#e2e8f0" }}>Post-Session Loudness:</span>
                            <span className="mono" style={{ color: "#10b981", fontWeight: "bold" }}>{postVas} / 10</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={10}
                            step={0.5}
                            value={postVas}
                            onChange={(e) => setPostVas(Number(e.target.value))}
                            style={{ width: "100%", accentColor: "#10b981" }}
                          />
                          <div className="row row--between">
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => setSoundPhase("idle")}
                            >
                              Skip Rating
                            </button>
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={() => logSoundRelief(true)}
                              style={{ background: "#10b981", borderColor: "#059669", fontWeight: "bold" }}
                            >
                              ✓ Save Session & Log Relief
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 6: REHABILITATION PROGRAMME PROGRESS & CHECKLIST */}
              {activeTab === "rehab_programme" && (
                <div className="stack stack-4">
                  {loadingRehab ? (
                    <Loading label="Loading rehabilitation programme..." />
                  ) : !rehabData ? (
                    <Panel tone="sunken" tight>
                      <p className="meta">No active rehabilitation programme found. Complete your initial assessment to generate a custom recovery plan.</p>
                    </Panel>
                  ) : (
                    <div className="stack stack-4">
                      {/* Progress Counters */}
                      <div className="grid grid-3" style={{ gap: "8px" }}>
                        <Panel tight style={{ background: "rgba(15,23,42,0.8)" }}>
                          <Readout
                            label="Today's Tasks"
                            value={`${rehabData.progress.completed_today.length}/${rehabData.today.length}`}
                            size="sm"
                            tone={rehabData.progress.completed_today.length === rehabData.today.length ? "ok" : "signal"}
                          />
                        </Panel>
                        <Panel tight style={{ background: "rgba(15,23,42,0.8)" }}>
                          <Readout
                            label="Day Streak"
                            value={rehabData.progress.streak_days}
                            size="sm"
                            tone={rehabData.progress.streak_days >= 3 ? "ok" : "data"}
                          />
                        </Panel>
                        <Panel tight style={{ background: "rgba(15,23,42,0.8)" }}>
                          <Readout
                            label="Weekly %"
                            value={fmt.pct100(rehabData.progress.week_completion_pct, 0)}
                            size="sm"
                            tone={rehabData.progress.week_completion_pct >= 70 ? "ok" : "data"}
                          />
                        </Panel>
                      </div>

                      {/* Overall Completion Meter */}
                      <div className="stack stack-1">
                        <div className="row row--between meta">
                          <span style={{ color: "#cbd5e1" }}>Overall Programme Completion:</span>
                          <strong style={{ color: "#fff" }}>{fmt.pct100(rehabData.progress.overall_completion_pct, 0)}</strong>
                        </div>
                        <Meter value={rehabData.progress.overall_completion_pct} max={100} tone="ok" />
                      </div>

                      {/* Today's Checklist */}
                      <div className="panel stack stack-3" style={{ background: "rgba(15,23,42,0.8)" }}>
                        <h4 style={{ color: "#fff", margin: 0 }}>Today's Assigned Rehab Checklist</h4>

                        <ul className="stack stack-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                          {rehabData.today.map((activity) => {
                            const isDone = rehabData.progress.completed_today.includes(activity.key);
                            return (
                              <li
                                key={activity.key}
                                className="row row--between panel"
                                style={{
                                  background: isDone ? "rgba(16, 185, 129, 0.15)" : "rgba(30, 41, 59, 0.7)",
                                  borderColor: isDone ? "rgba(16, 185, 129, 0.4)" : "rgba(148, 163, 184, 0.2)",
                                  padding: "8px 12px",
                                }}
                              >
                                <div className="stack stack-1" style={{ minWidth: 0 }}>
                                  <strong style={{ fontSize: "var(--fs-small)", color: "#fff" }}>
                                    {activity.key.replace(/_/g, " ").toUpperCase()} ({activity.minutes}m)
                                  </strong>
                                  <span className="meta" style={{ fontSize: "var(--fs-micro)", color: "#cbd5e1" }}>
                                    Slot: {activity.slot} {activity.because ? `· ${activity.because}` : ""}
                                  </span>
                                </div>

                                <button
                                  type="button"
                                  className={`btn btn--sm ${isDone ? "btn--primary" : "btn--outline"}`}
                                  disabled={rehabBusy.has(activity.key)}
                                  onClick={() => toggleRehabActivity(activity)}
                                  style={{
                                    background: isDone ? "#10b981" : "transparent",
                                    borderColor: isDone ? "#059669" : "rgba(148, 163, 184, 0.4)",
                                    color: "#fff",
                                    fontWeight: "bold",
                                  }}
                                >
                                  {isDone ? "✓ Done" : "Mark Done"}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>

          </div>
        </div>
      )}

      {/* CREATE SESSION MODAL */}
      {showCreateModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "var(--s4)",
          }}
        >
          <div
            className="panel stack stack-4"
            style={{
              maxWidth: "520px",
              width: "100%",
              background: "var(--surface-elevated, #0f172a)",
              border: "1px solid rgba(148, 163, 184, 0.25)",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
              borderRadius: "var(--radius-md)",
              padding: "var(--s5)",
            }}
          >
            <div className="row row--between" style={{ borderBottom: "1px solid var(--border)", paddingBottom: "var(--s3)" }}>
              <h2 style={{ margin: 0, fontSize: "var(--fs-headline-sm)", color: "#ffffff" }}>Create Group Therapy Session</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setShowCreateModal(false)}
                style={{ fontSize: "1.2rem", padding: "4px 8px", color: "#ffffff" }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSession} className="stack stack-3">
              <div>
                <label className="meta" style={{ display: "block", marginBottom: "6px", fontWeight: "600", color: "#ffffff" }}>
                  Session Title *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Evening Masking & Tinnitus Relaxation"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  className="input"
                  style={{
                    width: "100%",
                    background: "rgba(15, 23, 42, 0.95)",
                    color: "#ffffff",
                    border: "1px solid rgba(148, 163, 184, 0.4)",
                    borderRadius: "var(--radius-sm)",
                    padding: "12px 14px",
                  }}
                  required
                />
              </div>

              <div>
                <label className="meta" style={{ display: "block", marginBottom: "6px", fontWeight: "600", color: "#ffffff" }}>
                  Description / Session Focus
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Join us for a 30-minute peer sound exercise & discussion."
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  className="input"
                  style={{
                    width: "100%",
                    background: "rgba(15, 23, 42, 0.95)",
                    color: "#ffffff",
                    border: "1px solid rgba(148, 163, 184, 0.4)",
                    borderRadius: "var(--radius-sm)",
                    padding: "12px 14px",
                  }}
                />
              </div>

              <div>
                <label className="meta" style={{ display: "block", marginBottom: "6px", fontWeight: "600", color: "#ffffff" }}>
                  Google Meet Link (Optional)
                </label>
                <input
                  type="url"
                  placeholder="e.g. https://meet.google.com/xyz-abc-def"
                  value={createMeetUrl}
                  onChange={(e) => setCreateMeetUrl(e.target.value)}
                  className="input"
                  style={{
                    width: "100%",
                    background: "rgba(15, 23, 42, 0.95)",
                    color: "#ffffff",
                    border: "1px solid rgba(148, 163, 184, 0.4)",
                    borderRadius: "var(--radius-sm)",
                    padding: "12px 14px",
                  }}
                />
                <span className="meta" style={{ fontSize: "11px", marginTop: "4px", display: "block", color: "#cbd5e1" }}>
                  Provide a Google Meet URL for video/audio call integration.
                </span>
              </div>

              <div>
                <label className="meta" style={{ display: "block", marginBottom: "6px", fontWeight: "600", color: "#ffffff" }}>
                  Max Participants
                </label>
                <input
                  type="number"
                  min="2"
                  max="50"
                  value={createMaxCap}
                  onChange={(e) => setCreateMaxCap(Number(e.target.value))}
                  className="input"
                  style={{
                    width: "100%",
                    background: "rgba(15, 23, 42, 0.95)",
                    color: "#ffffff",
                    border: "1px solid rgba(148, 163, 184, 0.4)",
                    borderRadius: "var(--radius-sm)",
                    padding: "12px 14px",
                  }}
                />
              </div>

              <div className="row row--between" style={{ marginTop: "var(--s4)", borderTop: "1px solid var(--border)", paddingTop: "var(--s3)" }}>
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={creating || !createTitle.trim()}
                  style={{ fontWeight: "bold" }}
                >
                  {creating ? "Creating..." : "Create Session & Generate Permanent Code"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {showDeleteModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "var(--s4)",
          }}
        >
          <div
            className="panel stack stack-4"
            style={{
              maxWidth: "450px",
              width: "100%",
              background: "var(--surface-elevated, #0f172a)",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.8)",
              borderRadius: "var(--radius-md)",
              padding: "var(--s5)",
            }}
          >
            <h2 style={{ color: "#ffffff", margin: 0, fontSize: "var(--fs-headline-sm)" }}>Delete Therapy Room?</h2>
            <p style={{ color: "#e2e8f0", fontSize: "var(--fs-body)", lineHeight: "1.55", margin: "var(--s2) 0" }}>
              Are you sure you want to permanently delete <strong style={{ color: "#fca5a5", fontWeight: "700" }}>"{activeSession?.title}"</strong>? All participants will be disconnected.
            </p>

            <div className="row row--between" style={{ marginTop: "var(--s3)" }}>
              <button
                type="button"
                className="btn btn--outline"
                onClick={() => setShowDeleteModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleDeleteRoom}
                disabled={deletingRoom}
                style={{ background: "#dc2626", borderColor: "#b91c1c" }}
              >
                {deletingRoom ? "Deleting..." : "Yes, Delete Room"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
