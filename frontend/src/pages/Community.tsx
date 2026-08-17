/**
 * Local Tinnitus Community page.
 *
 * Provides local community networking, helpful non-clinical tinnitus resources,
 * announcements, and peer discussion while enforcing strict patient privacy.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type CommunityResponse } from "../api/client";
import { useSession } from "../state/session";
import { Field, Loading, Panel, Readout } from "../components/ui";
import { IconGlobe, IconUsers } from "../components/icons";

export default function Community() {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);

  const [data, setData] = useState<CommunityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states for location update
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [detectingLocation, setDetectingLocation] = useState(false);

  // Form state for creating a post
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    loadCommunity();
  }, []);

  async function loadCommunity() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.communities.myCommunity();
      setData(res);
      if (res.user_location) {
        setCountry(res.user_location.country || "");
        setState(res.user_location.state || "");
        setCity(res.user_location.city || "");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveLocation(e: React.FormEvent) {
    e.preventDefault();
    if (!country.trim() || !state.trim() || !city.trim()) {
      toast("Please fill in Country, State, and City.", "info");
      return;
    }
    setUpdatingLocation(true);
    try {
      const res = await api.communities.updateLocation({
        country: country.trim(),
        state: state.trim(),
        city: city.trim(),
      });
      setData(res);
      toast("Location updated & assigned to community!", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    } finally {
      setUpdatingLocation(false);
    }
  }

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      toast("Geolocation is not supported by your browser.", "info");
      return;
    }
    setDetectingLocation(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
          );
          if (res.ok) {
            const geo = await res.json();
            const addr = geo.address || {};
            const foundCountry = addr.country || "";
            const foundState = addr.state || addr.region || addr.province || "";
            const foundCity =
              addr.city || addr.town || addr.village || addr.municipality || addr.county || "";

            if (foundCountry) setCountry(foundCountry);
            if (foundState) setState(foundState);
            if (foundCity) setCity(foundCity);

            toast("Location detected! Please review and save.", "ok");
          } else {
            toast("Could not resolve location address. Please enter details manually.", "info");
          }
        } catch {
          toast("Location service unavailable. Please enter details manually.", "info");
        } finally {
          setDetectingLocation(false);
        }
      },
      (err) => {
        setDetectingLocation(false);
        toast(`Location access denied or unavailable (${err.message}).`, "info");
      },
      { timeout: 10000 }
    );
  }

  async function handleCreatePost(e: React.FormEvent) {
    e.preventDefault();
    if (!postContent.trim()) return;
    setPosting(true);
    try {
      await api.communities.createPost(postContent.trim());
      setPostContent("");
      toast("Post published to community!", "ok");
      await loadCommunity();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    } finally {
      setPosting(false);
    }
  }

  async function handleDeletePost(postId: number) {
    if (!window.confirm("Are you sure you want to delete this post?")) return;
    try {
      await api.communities.deletePost(postId);
      toast("Post deleted.", "ok");
      await loadCommunity();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("errors.generic"), "crit");
    }
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
      <Panel title="Community Unavailable" tone="crit" bracketed>
        <p className="meta">{error || t("errors.generic")}</p>
        <button
          type="button"
          className="btn btn--sm"
          style={{ marginTop: "var(--s3)" }}
          onClick={loadCommunity}
        >
          {t("common.retry")}
        </button>
      </Panel>
    );
  }

  const hasCommunity = Boolean(data.has_community && data.community);
  const community = data.community;
  const announcements = data.announcements || [];
  const resources = data.resources || [];
  const posts = data.posts || [];
  const userLocation = data.user_location || { country: "", state: "", city: "" };

  return (
    <div className="stack stack-6">
      {/* Header Banner */}
      <Panel bracketed tone={hasCommunity ? "default" : "sunken"}>
        <div className="row row--between" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "var(--s4)" }}>
          <div className="stack stack-2">
            <span className="chip chip--signal">
              <IconUsers size={15} /> Local Community
            </span>
            <h1 style={{ fontSize: "var(--fs-h2)", margin: 0 }}>
              {hasCommunity ? community?.name : "Tinnitus Patient Community"}
            </h1>
            {hasCommunity && (
              <p className="meta" style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                <IconGlobe size={16} />
                {community?.city}, {community?.state}, {community?.country}
              </p>
            )}
          </div>

          {hasCommunity && (
            <Readout
              label="Community Members"
              value={community?.member_count ?? 1}
              unit="members"
              tone="signal"
              size="lg"
            />
          )}
        </div>
      </Panel>

      {/* Missing Location or Update Location Section */}
      {!hasCommunity ? (
        <Panel title="Add Your Location to Join a Community" tone="signal" bracketed>
          <p className="lead" style={{ marginBottom: "var(--s4)" }}>
            Connect with patients in your city for support, habituation tips, and local resources.
          </p>
          <p className="meta dim" style={{ marginBottom: "var(--s5)" }}>
            Privacy Note: Your street address and precise location are never stored or exposed. Only Country, State, and City are used for community assignment.
          </p>

          <form className="stack stack-4" onSubmit={handleSaveLocation}>
            <div className="grid grid-3" style={{ gap: "var(--s4)" }}>
              <Field label="Country">
                <input
                  className="input"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="e.g. India"
                  required
                />
              </Field>

              <Field label="State / Province">
                <input
                  className="input"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  placeholder="e.g. Tamil Nadu"
                  required
                />
              </Field>

              <Field label="City">
                <input
                  className="input"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Chennai"
                  required
                />
              </Field>
            </div>

            <div className="row row--tight" style={{ gap: "var(--s3)", marginTop: "var(--s2)" }}>
              <button type="submit" className="btn btn--primary" disabled={updatingLocation}>
                {updatingLocation ? t("common.working") : "Save Location & Join Community"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleUseMyLocation}
                disabled={detectingLocation}
              >
                {detectingLocation ? "Detecting location…" : "Use my location"}
              </button>
            </div>
          </form>
        </Panel>
      ) : (
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "320px", gap: "var(--s6)" }}>
          {/* Main Feed */}
          <div className="stack stack-5">
            {/* Create Post */}
            <Panel title="Share with your local community" bracketed>
              <form className="stack stack-3" onSubmit={handleCreatePost}>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Share a coping strategy, ask a question, or post a positive habituation update…"
                  value={postContent}
                  onChange={(e) => setPostContent(e.target.value)}
                  required
                  maxLength={2000}
                />
                <div className="row row--between">
                  <span className="meta dim">
                    Medical reports & personal contact info are never shared.
                  </span>
                  <button type="submit" className="btn btn--primary btn--sm" disabled={posting || !postContent.trim()}>
                    {posting ? t("common.working") : "Publish Post"}
                  </button>
                </div>
              </form>
            </Panel>

            {/* Posts Feed */}
            <div className="stack stack-4">
              <h3 className="panel__title">Community Discussions</h3>

              {posts.length === 0 ? (
                <Panel tone="sunken" tight>
                  <p className="meta dim" style={{ textAlign: "center", padding: "var(--s4)" }}>
                    No posts in your community yet. Be the first to share a post!
                  </p>
                </Panel>
              ) : (
                posts.map((post) => (
                  <Panel key={post.id} tight>
                    <div className="stack stack-2">
                      <div className="row row--between" style={{ borderBottom: "1px solid var(--ink-line)", paddingBottom: "var(--s2)" }}>
                        <div className="row row--tight">
                          <span className="iconbadge iconbadge--sm">
                            <IconUsers size={14} />
                          </span>
                          <strong style={{ fontSize: "var(--fs-small)" }}>{post.author_name}</strong>
                        </div>
                        <span className="meta dim">{new Date(post.created_at).toLocaleString()}</span>
                      </div>

                      <p style={{ marginBlock: "var(--s2)", whiteSpace: "pre-wrap", fontSize: "var(--fs-small)" }}>
                        {post.content}
                      </p>

                      {post.is_own_post && (
                        <div className="row row--end" style={{ marginTop: "var(--s1)" }}>
                          <button
                            type="button"
                            className="btn btn--sm"
                            style={{ color: "var(--crit-ink)", fontSize: "var(--fs-tiny)", padding: "var(--s1) var(--s2)" }}
                            onClick={() => handleDeletePost(post.id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </Panel>
                ))
              )}
            </div>
          </div>

          {/* Sidebar Info: Announcements & Resources */}
          <div className="stack stack-4">
            {/* Announcements */}
            {announcements.length > 0 && (
              <Panel title="Announcements" tone="signal" tight>
                <div className="stack stack-3">
                  {announcements.map((a) => (
                    <div key={a.id} className="stack stack-1">
                      <strong style={{ fontSize: "var(--fs-small)" }}>{a.title}</strong>
                      <p className="meta" style={{ margin: 0 }}>{a.content}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {/* Resources */}
            <Panel title="Helpful Resources" tight>
              <div className="stack stack-3">
                {resources.map((r) => (
                  <div key={r.id} style={{ borderBottom: "1px dashed var(--ink-line)", paddingBottom: "var(--s2)" }}>
                    <span className="chip chip--ghost" style={{ fontSize: "var(--fs-micro)", marginBottom: "var(--s1)" }}>
                      {r.category}
                    </span>
                    <strong style={{ display: "block", fontSize: "var(--fs-small)" }}>{r.title}</strong>
                    {r.link && (
                      <a href={r.link} className="meta link" style={{ fontSize: "var(--fs-tiny)", color: "var(--signal)" }}>
                        Explore →
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </Panel>

            {/* Update location option */}
            <Panel tone="sunken" tight>
              <span className="label" style={{ marginBottom: "var(--s2)" }}>Your Location</span>
              <p className="meta" style={{ marginBottom: "var(--s3)" }}>
                {userLocation.city}, {userLocation.state}, {userLocation.country}
              </p>
              <button
                type="button"
                className="btn btn--sm btn--block"
                onClick={() => {
                  setCountry(userLocation.country || "");
                  setState(userLocation.state || "");
                  setCity(userLocation.city || "");
                  setData((prev) => (prev ? { ...prev, has_community: false, community: null } : null));
                }}
              >
                Change Location
              </button>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
