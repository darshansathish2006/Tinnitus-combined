/**
 * Modern Social-Media-Style Community Page for EchoSense AI.
 *
 * Header: "Your Community, Your Space"
 * Onboarding: First-time location-based guide with Yes/No join prompt.
 * Layout: 3-column responsive layout (Nav/Hashtags, Social Feed, Real-time Chatbox).
 * Features: Likes, Comments, Replies, Share, Hashtag filters, Telegram-style Chatbox with Live Online Count,
 *           WhatsApp-style Message Read Status info, and Settings location management navigation.
 */

import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  type CommunityResponse,
  type CommunityPost,
  type CommunityChatMessage,
} from "../api/client";
import { useSession } from "../state/session";
import { Loading } from "../components/ui";

export default function Community() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useSession((s) => s.toast);

  const [data, setData] = useState<CommunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // Feed & Filter state
  const [selectedTag, setSelectedTag] = useState<string>("All");
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);

  // Active post comments state: postId -> boolean (open/close)
  const [openComments, setOpenComments] = useState<Record<number, boolean>>({});
  const [commentInputs, setCommentInputs] = useState<Record<number, string>>({});
  const [replyingTo, setReplyingTo] = useState<Record<number, number | null>>({});

  // Real-time Chat state
  const [chatMessages, setChatMessages] = useState<CommunityChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [onlineCount, setOnlineCount] = useState(1);
  const [activeReadModalMsg, setActiveReadModalMsg] = useState<CommunityChatMessage | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadCommunity();
  }, []);

  // Poll chat messages every 4 seconds if community is joined
  useEffect(() => {
    if (!data?.joined_community) return;
    const interval = setInterval(async () => {
      try {
        const res = await api.communities.getChat();
        setChatMessages(res.messages);
        setOnlineCount(res.online_count);

        if (activeReadModalMsg) {
          const updated = res.messages.find((m) => m.id === activeReadModalMsg.id);
          if (updated) setActiveReadModalMsg(updated);
        }
      } catch {
        // silent fail on background poll
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [data?.joined_community, activeReadModalMsg]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  async function loadCommunity() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.communities.myCommunity();
      setData(res);
      if (res.chat_messages) {
        setChatMessages(res.chat_messages);
      }
      if (res.online_count) {
        setOnlineCount(res.online_count);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  async function handleJoinChoice(shouldJoin: boolean) {
    setJoining(true);
    try {
      const res = await api.communities.join(shouldJoin);
      setData(res);
      if (shouldJoin) {
        toast("Welcome to your local community!", "ok");
        if (res.chat_messages) setChatMessages(res.chat_messages);
        if (res.online_count) setOnlineCount(res.online_count);
      } else {
        toast("You have chosen not to join the local community.", "info");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    } finally {
      setJoining(false);
    }
  }

  async function handleCreatePost(e: React.FormEvent) {
    e.preventDefault();
    if (!postContent.trim()) return;
    setPosting(true);
    try {
      const newPost = await api.communities.createPost(postContent.trim());
      setPostContent("");
      toast("Post published to community!", "ok");
      setData((prev) =>
        prev
          ? {
              ...prev,
              posts: [newPost, ...prev.posts],
            }
          : null
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    } finally {
      setPosting(false);
    }
  }

  async function handleLikePost(postId: number) {
    try {
      const res = await api.communities.likePost(postId);
      setData((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          posts: prev.posts.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  likes_count: res.likes_count,
                  is_liked_by_me: res.is_liked_by_me,
                }
              : p
          ),
        };
      });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    }
  }

  async function handleDeletePost(postId: number) {
    if (!window.confirm("Are you sure you want to delete this post?")) return;
    try {
      await api.communities.deletePost(postId);
      toast("Post deleted.", "ok");
      setData((prev) =>
        prev ? { ...prev, posts: prev.posts.filter((p) => p.id !== postId) } : null
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    }
  }

  function toggleComments(postId: number) {
    setOpenComments((prev) => ({ ...prev, [postId]: !prev[postId] }));
  }

  async function handleAddComment(postId: number, e: React.FormEvent) {
    e.preventDefault();
    const content = (commentInputs[postId] || "").trim();
    if (!content) return;
    const parentId = replyingTo[postId] || null;

    try {
      const newComment = await api.communities.createComment(postId, content, parentId);
      setCommentInputs((prev) => ({ ...prev, [postId]: "" }));
      setReplyingTo((prev) => ({ ...prev, [postId]: null }));
      toast("Comment added!", "ok");

      setData((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          posts: prev.posts.map((p) => {
            if (p.id !== postId) return p;
            let updatedComments = [...p.comments];
            if (parentId === null) {
              updatedComments.push(newComment);
            } else {
              updatedComments = updatedComments.map((c) =>
                c.id === parentId
                  ? { ...c, replies: [...(c.replies || []), newComment] }
                  : c
              );
            }
            return {
              ...p,
              comments_count: p.comments_count + 1,
              comments: updatedComments,
            };
          }),
        };
      });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    }
  }

  async function handleDeleteComment(postId: number, commentId: number) {
    try {
      await api.communities.deleteComment(commentId);
      toast("Comment deleted.", "ok");
      setData((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          posts: prev.posts.map((p) => {
            if (p.id !== postId) return p;
            return {
              ...p,
              comments_count: Math.max(0, p.comments_count - 1),
              comments: p.comments.filter((c) => c.id !== commentId),
            };
          }),
        };
      });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    }
  }

  function handleSharePost(post: CommunityPost) {
    const postUrl = `${window.location.origin}/community#post-${post.id}`;
    navigator.clipboard.writeText(postUrl);
    toast("Post link copied to clipboard!", "ok");
  }

  async function handleSendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    setSendingChat(true);
    try {
      const msg = await api.communities.sendChat(chatInput.trim());
      setChatInput("");
      setChatMessages((prev) => [...prev, msg]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    } finally {
      setSendingChat(false);
    }
  }

  function formatHashtags(text: string) {
    const parts = text.split(/(#\w+)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("#")) {
        return (
          <span
            key={idx}
            onClick={() => setSelectedTag(part.slice(1))}
            style={{
              color: "var(--signal)",
              fontWeight: 600,
              cursor: "pointer",
              textDecoration: "underline",
              marginRight: "2px",
            }}
          >
            {part}
          </span>
        );
      }
      return part;
    });
  }

  if (loading) {
    return (
      <main className="wrap wrap--narrow" style={{ paddingTop: "var(--s16)" }}>
        <Loading label={t("common.loading")} />
      </main>
    );
  }

  if (error || !data) {
    return (
      <div className="panel panel--crit" style={{ padding: "var(--s6)", borderRadius: "12px" }}>
        <h3>Community Unavailable</h3>
        <p className="meta">{error || t("errors.generic")}</p>
        <button type="button" className="btn btn--sm" style={{ marginTop: "var(--s3)" }} onClick={loadCommunity}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  const { user_location, joined_community, community, posts, resources } = data;
  const locationLabel = `${user_location.city || "Local"}, ${user_location.state || ""}, ${user_location.country || ""}`;

  // Filter posts by hashtag
  const filteredPosts =
    selectedTag === "All"
      ? posts
      : posts.filter((p) => p.content.toLowerCase().includes(`#${selectedTag.toLowerCase()}`));

  // Preset hashtag tags
  const trendingTags = ["All", "SoundTherapy", "Habituation", "CBT", "CopingTips", "Events", "Support"];

  return (
    <div className="community-page-container stack stack-6" style={{ maxWidth: "1280px", margin: "0 auto", width: "100%" }}>
      {/* Dynamic Header */}
      <header
        style={{
          background: "linear-gradient(135deg, rgba(14, 165, 233, 0.08) 0%, rgba(99, 102, 241, 0.12) 100%)",
          border: "1px solid var(--ink-line)",
          borderRadius: "16px",
          padding: "var(--s6)",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s4)" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "var(--signal-subtle)", color: "var(--signal)", padding: "4px 12px", borderRadius: "20px", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
              EchoSense Social Space
            </div>
            {/* `data-tour` anchors the walkthrough's Community step. On the
                page header rather than on the feed, because a brand-new account
                has not joined a community yet and the feed is not rendered for
                them — the header is. */}
            <h1
              data-tour="community"
              style={{ fontSize: "2rem", fontWeight: 700, margin: "4px 0 8px 0", color: "var(--ink)" }}
            >
              Your Community, Your Space
            </h1>
            <p className="meta" style={{ display: "flex", alignItems: "center", gap: "6px", margin: 0, fontSize: "14px", color: "var(--ink-muted)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>{locationLabel}</span>
            </p>
          </div>

          {joined_community && community && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--ink-line)", borderRadius: "12px", padding: "12px 20px", textAlign: "right" }}>
              <div style={{ fontSize: "12px", color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Assigned Community
              </div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--ink)" }}>
                {community.name}
              </div>
              {/* Real-time Activity Status Display */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px", marginTop: "4px" }}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 8px #22c55e",
                    display: "inline-block",
                  }}
                />
                <span style={{ fontSize: "13px", color: "#16a34a", fontWeight: 700 }}>
                  🟢 {onlineCount} {onlineCount === 1 ? "Member Online" : "Members Online"}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--ink-muted)", marginTop: "2px" }}>
                Real-time Live Activity
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Onboarding Guide for Unjoined Members */}
      {!joined_community ? (
        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--ink-line)",
            borderRadius: "16px",
            padding: "var(--s8)",
            boxShadow: "0 8px 30px rgba(0, 0, 0, 0.04)",
          }}
        >
          <div style={{ maxWidth: "760px", margin: "0 auto", textAlign: "center" }}>
            <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "rgba(14, 165, 233, 0.1)", color: "var(--signal)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px auto" }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>

            <h2 style={{ fontSize: "1.75rem", fontWeight: 700, marginBottom: "12px", color: "var(--ink)" }}>
              Welcome to Your Local Tinnitus Support Network
            </h2>

            <p style={{ fontSize: "1.05rem", lineHeight: 1.6, color: "var(--ink-muted)", marginBottom: "28px" }}>
              Connect with fellow patients based in <strong>{locationLabel}</strong>. Share habituation strategies, discuss non-medical coping tips, react, comment, and converse in real-time.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px", marginBottom: "36px", textAlign: "left" }}>
              <div style={{ background: "var(--surface-sunken)", padding: "18px", borderRadius: "12px", border: "1px solid var(--ink-line)" }}>
                <div style={{ fontWeight: 700, color: "var(--signal)", marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>📍</span> Automatic Placement
                </div>
                <div style={{ fontSize: "13px", color: "var(--ink-muted)" }}>
                  Your community is identified automatically using your registered location in Settings (<strong>{user_location.city || "City"}</strong>).
                </div>
              </div>

              <div style={{ background: "var(--surface-sunken)", padding: "18px", borderRadius: "12px", border: "1px solid var(--ink-line)" }}>
                <div style={{ fontWeight: 700, color: "var(--signal)", marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>🔒</span> Confidential & Secure
                </div>
                <div style={{ fontSize: "13px", color: "var(--ink-muted)" }}>
                  Interact safely with local community members without exposing private contact info or health records.
                </div>
              </div>

              <div style={{ background: "var(--surface-sunken)", padding: "18px", borderRadius: "12px", border: "1px solid var(--ink-line)" }}>
                <div style={{ fontWeight: 700, color: "var(--signal)", marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>💬</span> Interactive Space
                </div>
                <div style={{ fontSize: "13px", color: "var(--ink-muted)" }}>
                  Hashtags, post reactions, nested comment replies, and a Telegram-style real-time community chatbox.
                </div>
              </div>
            </div>

            <div style={{ background: "rgba(14, 165, 233, 0.05)", border: "1px solid rgba(14, 165, 233, 0.2)", borderRadius: "14px", padding: "24px" }}>
              <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "16px", color: "var(--ink)" }}>
                Would you like to join your community?
              </h3>
              <div style={{ display: "flex", justifyContent: "center", gap: "16px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn--primary btn--lg"
                  style={{ minWidth: "160px", padding: "12px 28px", fontSize: "1rem", fontWeight: 600 }}
                  onClick={() => handleJoinChoice(true)}
                  disabled={joining}
                >
                  {joining ? "Joining..." : "Yes, Join Community"}
                </button>

                <button
                  type="button"
                  className="btn btn--lg"
                  style={{ minWidth: "160px", padding: "12px 28px", fontSize: "1rem" }}
                  onClick={() => handleJoinChoice(false)}
                  disabled={joining}
                >
                  No, Thanks
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        /* Main 3-Column Community Dashboard Layout */
        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 340px", gap: "24px", alignItems: "start" }}>

          {/* Left Column: Hashtag Navigation & Resources */}
          <aside className="stack stack-4" style={{ position: "sticky", top: "20px" }}>
            <div style={{ background: "var(--surface)", border: "1px solid var(--ink-line)", borderRadius: "14px", padding: "16px" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "12px", letterSpacing: "0.5px" }}>
                Trending Hashtags
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {trendingTags.map((tag) => {
                  const isActive = selectedTag.toLowerCase() === tag.toLowerCase();
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSelectedTag(tag)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 12px",
                        borderRadius: "8px",
                        border: "none",
                        background: isActive ? "var(--signal-subtle)" : "transparent",
                        color: isActive ? "var(--signal)" : "var(--ink)",
                        fontWeight: isActive ? 700 : 500,
                        fontSize: "14px",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <span>#{tag}</span>
                      {tag === "All" ? (
                        <span style={{ fontSize: "12px", opacity: 0.6 }}>{posts.length}</span>
                      ) : (
                        <span style={{ fontSize: "12px", opacity: 0.6 }}>
                          {posts.filter((p) => p.content.toLowerCase().includes(`#${tag.toLowerCase()}`)).length}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Resources Widget */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--ink-line)", borderRadius: "14px", padding: "16px" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "12px", letterSpacing: "0.5px" }}>
                Community Resources
              </h3>
              <div className="stack stack-3">
                {resources.map((r) => (
                  <div key={r.id} style={{ borderBottom: "1px dashed var(--ink-line)", paddingBottom: "10px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--signal)", background: "var(--signal-subtle)", padding: "2px 6px", borderRadius: "4px" }}>
                      {r.category}
                    </span>
                    <strong style={{ display: "block", fontSize: "13px", marginTop: "4px", color: "var(--ink)" }}>{r.title}</strong>
                    {r.link && (
                      /* Router navigation, not a bare `href`. These are in-app
                         routes, and a plain anchor makes the browser perform a
                         document navigation: the whole SPA reboots, the session
                         re-hydrates, and the fragment is resolved against a page
                         that has not rendered its sections yet — so the reader
                         lands at the top of the guide rather than on the entry
                         they asked for. `navigate` keeps it a route change, and
                         the guide scrolls to the anchor once it has mounted. */
                      <button
                        type="button"
                        onClick={() => navigate(r.link!)}
                        className="meta link"
                        style={{
                          fontSize: "12px",
                          color: "var(--signal)",
                          marginTop: "2px",
                          display: "inline-block",
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          font: "inherit",
                          textAlign: "left",
                        }}
                      >
                        View Guide →
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Location Settings Link */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--ink-line)", borderRadius: "14px", padding: "16px" }}>
              <h3 style={{ fontSize: "13px", fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)", marginBottom: "8px", letterSpacing: "0.5px" }}>
                Location Setting
              </h3>
              <p style={{ fontSize: "12px", color: "var(--ink-muted)", marginBottom: "12px", lineHeight: 1.4 }}>
                Change your community by updating your registered city in Settings.
              </p>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                style={{ width: "100%", fontSize: "12px", fontWeight: 600 }}
                onClick={() => navigate("/settings")}
              >
                ⚙️ Go to Settings →
              </button>
            </div>
          </aside>

          {/* Middle Column: Social Posts Feed */}
          <main className="stack stack-5">
            {/* Create Post Box */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--ink-line)", borderRadius: "14px", padding: "20px", boxShadow: "0 2px 10px rgba(0, 0, 0, 0.02)" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "12px", color: "var(--ink)" }}>
                Start a Discussion
              </h3>
              <form onSubmit={handleCreatePost} className="stack stack-3">
                <textarea
                  className="input"
                  rows={3}
                  placeholder={`Share habituation tips, ask a question, or post updates... (e.g. #${user_location.city || "Chennai"} #SoundTherapy)`}
                  value={postContent}
                  onChange={(e) => setPostContent(e.target.value)}
                  maxLength={2000}
                  style={{ width: "100%", borderRadius: "10px", padding: "12px", fontSize: "14px" }}
                />

                {/* Quick hashtag shortcuts */}
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", color: "var(--ink-muted)" }}>Quick Tags:</span>
                  {["#" + (user_location.city || "Chennai"), "#SoundTherapy", "#Habituation", "#CopingTips"].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setPostContent((prev) => prev ? `${prev} ${tag}` : tag)}
                      style={{ background: "var(--surface-sunken)", border: "1px solid var(--ink-line)", borderRadius: "16px", padding: "2px 10px", fontSize: "12px", color: "var(--signal)", cursor: "pointer" }}
                    >
                      + {tag}
                    </button>
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "8px" }}>
                  <span style={{ fontSize: "12px", color: "var(--ink-muted)" }}>
                    Posts are visible to members in {user_location.city || "your community"}.
                  </span>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={posting || !postContent.trim()} style={{ fontWeight: 600, padding: "8px 20px" }}>
                    {posting ? "Publishing..." : "Publish Post"}
                  </button>
                </div>
              </form>
            </div>

            {/* Posts List */}
            <div className="stack stack-4">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0, color: "var(--ink)" }}>
                  {selectedTag === "All" ? "Recent Discussions" : `Posts tagged #${selectedTag}`}
                </h3>
                {selectedTag !== "All" && (
                  <button type="button" className="btn btn--sm" onClick={() => setSelectedTag("All")} style={{ fontSize: "12px" }}>
                    Clear Filter
                  </button>
                )}
              </div>

              {filteredPosts.length === 0 ? (
                <div style={{ background: "var(--surface-sunken)", border: "1px solid var(--ink-line)", borderRadius: "14px", padding: "40px", textAlign: "center" }}>
                  <p className="meta" style={{ margin: 0, fontSize: "14px" }}>
                    No posts found for this filter. Be the first to start a conversation!
                  </p>
                </div>
              ) : (
                filteredPosts.map((post) => {
                  const isCommentsOpen = Boolean(openComments[post.id]);
                  const avatarInitial = (post.author_name || "M").charAt(0).toUpperCase();
                  return (
                    <article
                      key={post.id}
                      id={`post-${post.id}`}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--ink-line)",
                        borderRadius: "14px",
                        padding: "20px",
                        boxShadow: "0 2px 12px rgba(0, 0, 0, 0.02)",
                        transition: "box-shadow 0.2s ease",
                      }}
                    >
                      {/* Post Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "linear-gradient(135deg, #0ea5e9, #6366f1)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "14px" }}>
                            {avatarInitial}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--ink)" }}>
                              {post.author_name}
                            </div>
                            <div style={{ fontSize: "12px", color: "var(--ink-muted)" }}>
                              {new Date(post.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                            </div>
                          </div>
                        </div>

                        {post.is_own_post && (
                          <button
                            type="button"
                            onClick={() => handleDeletePost(post.id)}
                            style={{ background: "transparent", border: "none", color: "var(--crit-ink)", fontSize: "12px", cursor: "pointer", opacity: 0.8 }}
                          >
                            Delete
                          </button>
                        )}
                      </div>

                      {/* Content */}
                      <div style={{ fontSize: "14.5px", lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap", marginBottom: "16px" }}>
                        {formatHashtags(post.content)}
                      </div>

                      {/* Interaction Bar */}
                      <div style={{ display: "flex", alignItems: "center", gap: "16px", borderTop: "1px solid var(--ink-line)", paddingTop: "12px" }}>
                        {/* Like Button */}
                        <button
                          type="button"
                          onClick={() => handleLikePost(post.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            background: post.is_liked_by_me ? "rgba(239, 68, 68, 0.1)" : "transparent",
                            border: "none",
                            borderRadius: "20px",
                            padding: "6px 12px",
                            color: post.is_liked_by_me ? "#ef4444" : "var(--ink-muted)",
                            fontWeight: post.is_liked_by_me ? 700 : 500,
                            fontSize: "13px",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill={post.is_liked_by_me ? "#ef4444" : "none"} stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                          <span>{post.likes_count}</span>
                        </button>

                        {/* Comment Button */}
                        <button
                          type="button"
                          onClick={() => toggleComments(post.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            background: isCommentsOpen ? "var(--signal-subtle)" : "transparent",
                            border: "none",
                            borderRadius: "20px",
                            padding: "6px 12px",
                            color: isCommentsOpen ? "var(--signal)" : "var(--ink-muted)",
                            fontWeight: isCommentsOpen ? 700 : 500,
                            fontSize: "13px",
                            cursor: "pointer",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                          <span>{post.comments_count} Comments</span>
                        </button>

                        {/* Share Button */}
                        <button
                          type="button"
                          onClick={() => handleSharePost(post)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            background: "transparent",
                            border: "none",
                            borderRadius: "20px",
                            padding: "6px 12px",
                            color: "var(--ink-muted)",
                            fontSize: "13px",
                            cursor: "pointer",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                          <span>Share</span>
                        </button>
                      </div>

                      {/* Comments Section Tray */}
                      {isCommentsOpen && (
                        <div style={{ marginTop: "16px", borderTop: "1px dashed var(--ink-line)", paddingTop: "16px" }}>
                          {/* List of Comments */}
                          {post.comments.length > 0 && (
                            <div className="stack stack-3" style={{ marginBottom: "16px" }}>
                              {post.comments.map((comment) => (
                                <div key={comment.id} style={{ background: "var(--surface-sunken)", borderRadius: "10px", padding: "12px", border: "1px solid var(--ink-line)" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                                    <strong style={{ fontSize: "13px", color: "var(--ink)" }}>{comment.author_name}</strong>
                                    <span style={{ fontSize: "11px", color: "var(--ink-muted)" }}>
                                      {new Date(comment.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  </div>
                                  <p style={{ margin: "4px 0 8px 0", fontSize: "13.5px", color: "var(--ink)" }}>
                                    {comment.content}
                                  </p>
                                  <div style={{ display: "flex", gap: "12px", fontSize: "12px" }}>
                                    <button
                                      type="button"
                                      onClick={() => setReplyingTo((prev) => ({ ...prev, [post.id]: comment.id }))}
                                      style={{ background: "none", border: "none", color: "var(--signal)", cursor: "pointer", padding: 0, fontWeight: 600 }}
                                    >
                                      Reply
                                    </button>
                                    {comment.is_own_comment && (
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteComment(post.id, comment.id)}
                                        style={{ background: "none", border: "none", color: "var(--crit-ink)", cursor: "pointer", padding: 0 }}
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>

                                  {/* Replies Thread */}
                                  {comment.replies && comment.replies.length > 0 && (
                                    <div style={{ marginLeft: "16px", marginTop: "10px", borderLeft: "2px solid var(--signal-subtle)", paddingLeft: "10px" }} className="stack stack-2">
                                      {comment.replies.map((reply) => (
                                        <div key={reply.id} style={{ background: "var(--surface)", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--ink-line)" }}>
                                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <strong style={{ fontSize: "12px", color: "var(--ink)" }}>{reply.author_name}</strong>
                                            <span style={{ fontSize: "10px", color: "var(--ink-muted)" }}>
                                              {new Date(reply.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                            </span>
                                          </div>
                                          <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--ink)" }}>
                                            {reply.content}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Comment Form */}
                          <form onSubmit={(e) => handleAddComment(post.id, e)} style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
                            {replyingTo[post.id] && (
                              <div style={{ fontSize: "12px", color: "var(--signal)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span>Replying to comment #{replyingTo[post.id]}</span>
                                <button type="button" onClick={() => setReplyingTo((prev) => ({ ...prev, [post.id]: null }))} style={{ background: "none", border: "none", color: "var(--ink-muted)", cursor: "pointer" }}>
                                  Cancel
                                </button>
                              </div>
                            )}
                            <div style={{ display: "flex", gap: "8px" }}>
                              <input
                                className="input"
                                type="text"
                                placeholder={replyingTo[post.id] ? "Write a reply..." : "Write a comment..."}
                                value={commentInputs[post.id] || ""}
                                onChange={(e) => setCommentInputs((prev) => ({ ...prev, [post.id]: e.target.value }))}
                                style={{ flex: 1, borderRadius: "20px", padding: "8px 14px", fontSize: "13px" }}
                              />
                              <button type="submit" className="btn btn--primary btn--sm" style={{ borderRadius: "20px" }}>
                                Send
                              </button>
                            </div>
                          </form>
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </div>

            {/* Bottom Location Management Option */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--ink-line)",
                borderRadius: "16px",
                padding: "24px 28px",
                marginTop: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "16px",
                boxShadow: "0 4px 20px rgba(0, 0, 0, 0.02)",
              }}
            >
              <div>
                <h3 style={{ fontSize: "1.05rem", fontWeight: 700, margin: "0 0 4px 0", color: "var(--ink)" }}>
                  Looking to Change Your Community Location?
                </h3>
                <p style={{ fontSize: "13.5px", color: "var(--ink-muted)", margin: 0, lineHeight: 1.45 }}>
                  Your community assignment is managed in <strong>Settings</strong>. Update your registered city in Settings to automatically switch communities.
                </p>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => navigate("/settings")}
                style={{ fontWeight: 600, whiteSpace: "nowrap", padding: "10px 20px" }}
              >
                Change Location in Settings →
              </button>
            </div>
          </main>

          {/* Right Column: Telegram-Style Real-Time Chatbox */}
          <aside
            style={{
              background: "var(--surface)",
              border: "1px solid var(--ink-line)",
              borderRadius: "16px",
              height: "calc(100vh - 160px)",
              maxHeight: "680px",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.04)",
              position: "sticky",
              top: "20px",
              overflow: "hidden",
            }}
          >
            {/* Chat Header */}
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid var(--ink-line)",
                background: "linear-gradient(90deg, rgba(14, 165, 233, 0.08), rgba(99, 102, 241, 0.08))",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "var(--ink)" }}>
                  Live Community Chat
                </h3>
                <div style={{ fontSize: "12px", color: "var(--ink-muted)", marginTop: "2px" }}>
                  {community?.name}
                </div>
              </div>

              {/* Online Indicator Badge */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "rgba(34, 197, 94, 0.15)",
                  color: "#16a34a",
                  padding: "4px 10px",
                  borderRadius: "16px",
                  fontSize: "12px",
                  fontWeight: 700,
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 8px #22c55e",
                    display: "inline-block",
                  }}
                />
                <span>🟢 {onlineCount} Online</span>
              </div>
            </div>

            {/* Chat Messages Feed */}
            <div
              style={{
                flex: 1,
                padding: "16px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                background: "var(--surface-sunken)",
              }}
            >
              {chatMessages.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--ink-muted)", fontSize: "13px", marginTop: "auto", marginBottom: "auto" }}>
                  No chat messages yet. Say hello to your community!
                </div>
              ) : (
                chatMessages.map((msg) => {
                  const isMine = msg.is_own_message;
                  const isReadByAll = (msg.unread_members || []).length === 0;
                  const isReadBySome = (msg.read_by_count || 0) > 1;

                  return (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: isMine ? "flex-end" : "flex-start",
                        maxWidth: "84%",
                      }}
                    >
                      <div
                        style={{
                          background: isMine
                            ? "linear-gradient(135deg, #0ea5e9, #0284c7)"
                            : "var(--surface)",
                          color: isMine ? "#ffffff" : "var(--ink)",
                          border: isMine ? "none" : "1px solid var(--ink-line)",
                          borderRadius: isMine ? "14px 14px 2px 14px" : "14px 14px 14px 2px",
                          padding: "10px 14px",
                          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.03)",
                        }}
                      >
                        {!isMine && (
                          <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--signal)", marginBottom: "4px" }}>
                            {msg.sender_name}
                          </div>
                        )}
                        <div style={{ fontSize: "13.5px", lineHeight: 1.45, wordBreak: "break-word" }}>
                          {msg.content}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: "6px",
                            fontSize: "10px",
                            opacity: 0.9,
                            marginTop: "4px",
                          }}
                        >
                          <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>

                          {/* WhatsApp-Style Read Status Indicator on Own Messages */}
                          {isMine && (
                            <button
                              type="button"
                              onClick={() => setActiveReadModalMsg(msg)}
                              title="Click to view message read receipts"
                              style={{
                                background: "none",
                                border: "none",
                                color: "#ffffff",
                                cursor: "pointer",
                                padding: 0,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "3px",
                                fontWeight: 600,
                              }}
                            >
                              {isReadByAll ? (
                                <span style={{ color: "#7dd3fc", fontWeight: 800 }} title="Read by all members">✓✓</span>
                              ) : isReadBySome ? (
                                <span style={{ color: "#e0f2fe", fontWeight: 700 }} title="Delivered & read by some">✓✓</span>
                              ) : (
                                <span style={{ color: "#bae6fd" }} title="Sent">✓</span>
                              )}
                              <span style={{ textDecoration: "underline", fontSize: "10px" }}>
                                Read ({msg.read_by_members ? msg.read_by_members.length : msg.read_by_count})
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat Composer Input */}
            <form
              onSubmit={handleSendChat}
              style={{
                padding: "12px",
                borderTop: "1px solid var(--ink-line)",
                background: "var(--surface)",
                display: "flex",
                gap: "8px",
              }}
            >
              <input
                className="input"
                type="text"
                placeholder="Type a message..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                style={{ flex: 1, borderRadius: "20px", padding: "8px 14px", fontSize: "13px" }}
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={sendingChat || !chatInput.trim()}
                style={{ borderRadius: "50%", width: "36px", height: "36px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            </form>
          </aside>
        </div>
      )}

      {/* WhatsApp-Style Read Status Info Modal */}
      {activeReadModalMsg && (
        /* A popover anchored bottom-right rather than a centred modal behind a
           full-screen scrim. Message info is a glance — "who has seen this?" —
           and dimming the entire page to answer it hid the conversation the
           question was about. The backdrop is kept but made transparent so a
           click anywhere still dismisses it, which is the one thing the scrim
           was genuinely doing. */
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "transparent",
            zIndex: 1000,
          }}
          onClick={() => setActiveReadModalMsg(null)}
        >
          <div
            role="dialog"
            aria-label="Message info"
            style={{
              position: "fixed",
              right: "24px",
              bottom: "24px",
              background: "var(--paper-raised)",
              border: "var(--hairline) solid var(--ink)",
              borderRadius: "14px",
              padding: "14px",
              width: "min(300px, calc(100vw - 32px))",
              maxHeight: "min(360px, calc(100vh - 48px))",
              overflowY: "auto",
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <h3 style={{ fontSize: "0.9rem", fontWeight: 700, margin: 0, color: "var(--ink)" }}>
                Message Info
              </h3>
              <button
                type="button"
                onClick={() => setActiveReadModalMsg(null)}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "var(--ink-3)" }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                fontSize: "12px",
                lineHeight: 1.45,
                color: "var(--ink)",
                marginBottom: "12px",
                background: "var(--paper-sunken)",
                padding: "8px 10px",
                borderRadius: "8px",
                borderLeft: "3px solid var(--signal)",
                maxHeight: "56px",
                overflow: "hidden",
              }}
            >
              "{activeReadModalMsg.content}"
            </div>

            <div className="stack stack-4">
              {/* Read by section */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                  <span style={{ color: "#16a34a", fontWeight: 700 }}>✓✓</span>
                  <h4 style={{ fontSize: "13.5px", fontWeight: 700, color: "#16a34a", margin: 0 }}>
                    Read by ({activeReadModalMsg.read_by_members ? activeReadModalMsg.read_by_members.length : 0})
                  </h4>
                </div>
                {!activeReadModalMsg.read_by_members || activeReadModalMsg.read_by_members.length === 0 ? (
                  <div style={{ fontSize: "12px", color: "var(--ink-3)", paddingLeft: "20px" }}>No members have read this message yet.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", paddingLeft: "4px" }}>
                    {activeReadModalMsg.read_by_members.map((m, idx) => (
                      <span key={idx} style={{ background: "rgba(34, 197, 94, 0.12)", color: "#16a34a", border: "1px solid rgba(34, 197, 94, 0.3)", padding: "4px 12px", borderRadius: "14px", fontSize: "12px", fontWeight: 600 }}>
                        {m}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Not read yet section */}
              <div style={{ marginTop: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                  <span style={{ color: "var(--ink-3)", fontWeight: 700 }}>○</span>
                  <h4 style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--ink-3)", margin: 0 }}>
                    Not read yet ({activeReadModalMsg.unread_members ? activeReadModalMsg.unread_members.length : 0})
                  </h4>
                </div>
                {!activeReadModalMsg.unread_members || activeReadModalMsg.unread_members.length === 0 ? (
                  <div style={{ fontSize: "12px", color: "#16a34a", fontWeight: 600, paddingLeft: "20px" }}>
                    All community members have read this message!
                  </div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", paddingLeft: "4px" }}>
                    {activeReadModalMsg.unread_members.map((m, idx) => (
                      <span key={idx} style={{ background: "var(--paper-sunken)", color: "var(--ink-3)", padding: "4px 12px", borderRadius: "14px", fontSize: "12px", border: "var(--hairline) solid var(--line-faint)" }}>
                        {m}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              className="btn btn--block btn--sm"
              style={{ marginTop: "24px" }}
              onClick={() => setActiveReadModalMsg(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
