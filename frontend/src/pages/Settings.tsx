import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../state/session";
import { api, UserLocation, Community } from "../api/client";
import { Panel, ThemeToggle, Loading } from "../components/ui";
import { LanguageSelector } from "../components/LanguageSelector";
import { IconUser, IconGlobe, IconClose } from "../components/icons";

export default function Settings() {
  const navigate = useNavigate();
  const session = useSession((s) => s.session);
  const hydrate = useSession((s) => s.hydrate);

  const [loading, setLoading] = useState(true);
  const [editingLocation, setEditingLocation] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [location, setLocation] = useState<UserLocation>({
    country: "India",
    state: "Tamil Nadu",
    city: "Chennai",
  });

  const [assignedCommunity, setAssignedCommunity] = useState<Community | null>(null);

  const [formCountry, setFormCountry] = useState("India");
  const [formState, setFormState] = useState("Tamil Nadu");
  const [formCity, setFormCity] = useState("Chennai");

  useEffect(() => {
    let mounted = true;
    async function loadData() {
      try {
        setLoading(true);
        const data = await api.communities.myCommunity();
        if (mounted) {
          if (data.user_location) {
            setLocation(data.user_location);
            setFormCountry(data.user_location.country || "India");
            setFormState(data.user_location.state || "Tamil Nadu");
            setFormCity(data.user_location.city || "Chennai");
          }
          if (data.community) {
            setAssignedCommunity(data.community);
          }
        }
      } catch (err: any) {
        console.error("Failed to load settings data:", err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadData();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSaveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCountry.trim() || !formState.trim() || !formCity.trim()) {
      setErrorMessage("Please fill in Country, State, and City.");
      return;
    }

    try {
      setSavingLocation(true);
      setErrorMessage(null);
      setSuccessMessage(null);

      const res = await api.communities.updateLocation({
        country: formCountry.trim(),
        state: formState.trim(),
        city: formCity.trim(),
      });

      if (res.user_location) {
        setLocation(res.user_location);
      }
      if (res.community) {
        setAssignedCommunity(res.community);
      }

      await hydrate();
      setEditingLocation(false);
      setSuccessMessage(`Location updated! You are now joined to "${res.community?.name || `${formCity} Community`}".`);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update location. Please try again.");
    } finally {
      setSavingLocation(false);
    }
  };

  if (loading) {
    return <Loading label="Loading settings..." />;
  }

  return (
    <div className="wrap stack stack-6">
      {/* Header */}
      <div className="row row--between">
        <div>
          <span className="label label--signal">ACCOUNT & PREFERENCES</span>
          <h1 style={{ marginTop: "var(--s1)" }}>Settings</h1>
          <p className="meta">Manage your account profile, preferences, and community location.</p>
        </div>
        <button type="button" className="btn btn--outline" onClick={() => navigate("/community")}>
          ← Return to Community
        </button>
      </div>

      {successMessage && (
        <div
          className="panel panel--ok row row--between"
          style={{ padding: "var(--s3) var(--s4)", borderRadius: "var(--radius-sm)" }}
        >
          <div className="row row--tight">
            <span className="chip chip--ok">Updated</span>
            <strong style={{ fontSize: "var(--fs-small)" }}>{successMessage}</strong>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setSuccessMessage(null)}
          >
            <IconClose size={16} />
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          className="panel panel--crit row row--between"
          style={{ padding: "var(--s3) var(--s4)", borderRadius: "var(--radius-sm)" }}
        >
          <div className="row row--tight">
            <span className="chip chip--crit">Error</span>
            <strong style={{ fontSize: "var(--fs-small)" }}>{errorMessage}</strong>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setErrorMessage(null)}
          >
            <IconClose size={16} />
          </button>
        </div>
      )}

      {/* Grid of Settings sections */}
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {/* Card 1: Community Location Management (Single Source of Truth) */}
        <Panel title="Community Location" bracketed>
          <div className="stack stack-4">
            <p className="meta">
              Your registered location is the <strong>single source of truth</strong> for your local support community assignment.
            </p>

            {!editingLocation ? (
              <div className="stack stack-3">
                <div
                  style={{
                    padding: "var(--s4)",
                    background: "var(--paper-sunken)",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--hairline) solid var(--line-faint)",
                  }}
                >
                  <div className="row row--between" style={{ marginBottom: "var(--s3)" }}>
                    <div className="row row--tight">
                      <span className="iconbadge iconbadge--solid iconbadge--sm">
                        <IconGlobe size={16} />
                      </span>
                      <strong style={{ fontSize: "var(--fs-body)" }}>Current Registered Location</strong>
                    </div>
                    <span className="chip chip--signal">Active</span>
                  </div>

                  <div className="grid grid-3" style={{ gap: "var(--s3)" }}>
                    <div>
                      <span className="label">Country</span>
                      <strong style={{ fontSize: "var(--fs-small)" }}>{location.country || "Not Set"}</strong>
                    </div>
                    <div>
                      <span className="label">State</span>
                      <strong style={{ fontSize: "var(--fs-small)" }}>{location.state || "Not Set"}</strong>
                    </div>
                    <div>
                      <span className="label">City</span>
                      <strong style={{ fontSize: "var(--fs-small)" }}>{location.city || "Not Set"}</strong>
                    </div>
                  </div>

                  {assignedCommunity && (
                    <div
                      style={{
                        marginTop: "var(--s3)",
                        paddingTop: "var(--s3)",
                        borderTop: "var(--hairline) solid var(--line-faint)",
                      }}
                    >
                      <span className="label">Assigned Community</span>
                      <div className="row row--tight" style={{ marginTop: "2px" }}>
                        <span className="dot dot--live" style={{ color: "#10B981" }} />
                        <strong style={{ fontSize: "var(--fs-small)", color: "var(--signal-ink)" }}>
                          {assignedCommunity.name}
                        </strong>
                      </div>
                    </div>
                  )}
                </div>

                <div className="row row--between">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      setFormCountry(location.country || "India");
                      setFormState(location.state || "Tamil Nadu");
                      setFormCity(location.city || "Chennai");
                      setEditingLocation(true);
                    }}
                  >
                    Edit / Change Location
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => navigate("/community")}
                  >
                    Go to Community Page →
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSaveLocation} className="stack stack-4">
                <div className="field">
                  <label className="label">Country</label>
                  <input
                    type="text"
                    className="input"
                    value={formCountry}
                    onChange={(e) => setFormCountry(e.target.value)}
                    placeholder="e.g. India"
                    required
                  />
                </div>

                <div className="field">
                  <label className="label">State / Province</label>
                  <input
                    type="text"
                    className="input"
                    value={formState}
                    onChange={(e) => setFormState(e.target.value)}
                    placeholder="e.g. Tamil Nadu"
                    required
                  />
                </div>

                <div className="field">
                  <label className="label">City</label>
                  <input
                    type="text"
                    className="input"
                    value={formCity}
                    onChange={(e) => setFormCity(e.target.value)}
                    placeholder="e.g. Chennai"
                    required
                  />
                </div>

                <div
                  style={{
                    padding: "var(--s3)",
                    background: "var(--info-wash)",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--hairline) solid var(--info)",
                  }}
                >
                  <p className="meta" style={{ color: "var(--info-ink)" }}>
                    <strong>Note:</strong> Updating your city will reassign you to the corresponding local community. You will leave your current community feed and automatically join the new location's feed.
                  </p>
                </div>

                <div className="row row--tight">
                  <button type="submit" className="btn btn--primary" disabled={savingLocation}>
                    {savingLocation ? "Saving..." : "Save Location Changes"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setEditingLocation(false)}
                    disabled={savingLocation}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </Panel>

        {/* Card 2: User Account Profile */}
        <Panel title="User Account Profile" bracketed>
          <div className="stack stack-4">
            <div className="row row--tight">
              <span className="iconbadge iconbadge--solid">
                <IconUser size={20} />
              </span>
              <div>
                <h4 style={{ marginBottom: "2px" }}>{session?.full_name || "User"}</h4>
                <p className="meta">{session?.role?.toUpperCase()} ACCOUNT</p>
              </div>
            </div>

            <div className="stack stack-2">
              <div>
                <span className="label">Role</span>
                <span className="chip chip--ghost" style={{ marginTop: "4px" }}>
                  {session?.role}
                </span>
              </div>

              <div>
                <span className="label">Account Status</span>
                <span className="chip chip--ok" style={{ marginTop: "4px" }}>
                  Verified Active
                </span>
              </div>
            </div>

            <div
              style={{
                paddingTop: "var(--s4)",
                borderTop: "var(--hairline) solid var(--line-faint)",
              }}
            >
              <h4 style={{ fontSize: "var(--fs-small)", marginBottom: "var(--s2)" }}>
                Display Preferences & Theme
              </h4>
              <div className="row row--between">
                <span className="meta">Theme Mode</span>
                <ThemeToggle />
              </div>
              <div className="row row--between" style={{ marginTop: "var(--s2)" }}>
                <span className="meta">Language</span>
                <LanguageSelector variant="compact" />
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
