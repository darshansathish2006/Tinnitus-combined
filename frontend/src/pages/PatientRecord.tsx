/**
 * Clinician view of one patient.
 *
 * The trajectory chart comes first, because the question a clinician actually has
 * at follow-up is "is this working?", and the answer is a direction, not a number.
 * The AI note draft is explicitly a draft: it is offered pre-filled into an
 * editable field with a signature step, never filed automatically.
 */

import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { useSession } from "../state/session";
import {
  Chip,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  Panel,
  Readout,
  UrgencyChip,
  fmt,
  useAsync,
} from "../components/ui";
import { Audiogram, ChartLegend, ShapWaterfall, TrendChart } from "../components/charts";
import { DailyMonitoring } from "../components/DailyMonitoring";

// Three.js only loads when a clinician actually opens a record.
const EarModel = lazy(() => import("../components/EarModel"));

export default function PatientRecord() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const patientId = Number(id);
  const navigate = useNavigate();
  const actAsPatient = useSession((s) => s.actAsPatient);
  const toast = useSession((s) => s.toast);

  const overview = useAsync(() => api.clinician.overview(patientId), [patientId]);
  /**
   * The patient's daily monitoring.
   *
   * Fetched separately and allowed to fail quietly: the endpoint refuses for a
   * patient who is not on this clinician's caseload, and a record that is
   * otherwise readable should not be replaced by an error because one optional
   * panel was declined.
   */
  const monitoring = useAsync(async () => {
    try {
      return await api.clinician.monitoring(patientId);
    } catch {
      return null;
    }
  }, [patientId]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [noteCodes, setNoteCodes] = useState<any[]>([]);
  const [savingNote, setSavingNote] = useState(false);
  const [apptOpen, setApptOpen] = useState(false);
  const [apptWhen, setApptWhen] = useState("");
  const [apptKind, setApptKind] = useState("follow_up");

  // Scope the API client to this patient so the assessment/therapy endpoints work.
  useEffect(() => {
    if (overview.data?.patient) {
      actAsPatient(patientId, overview.data.patient.full_name);
    }
  }, [overview.data, patientId, actAsPatient]);

  const latestId = overview.data?.latest_assessment_id ?? null;
  const analysis = useAsync(
    () => (latestId ? api.assessments.analysis(latestId) : Promise.resolve(null)),
    [latestId]
  );

  async function draftNote() {
    if (!latestId) return;
    try {
      const draft = await api.reports.noteDraft(latestId);
      setNoteBody(
        `SUBJECTIVE\n${draft.subjective}\n\nOBJECTIVE\n${draft.objective}\n\nASSESSMENT\n${draft.assessment}\n\nPLAN\n${draft.plan}`
      );
      setNoteCodes(draft.icd11_codes ?? []);
      setNoteOpen(true);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("record.noteDraftFailed"), "crit");
    }
  }

  async function saveNote() {
    setSavingNote(true);
    try {
      await api.clinician.createNote({
        patient_id: patientId,
        body: noteBody,
        icd11_codes: noteCodes,
        ai_draft: false,
      });
      await overview.reload();
      setNoteOpen(false);
      toast(t("record.noteFiled"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("record.noteFailed"), "crit");
    } finally {
      setSavingNote(false);
    }
  }

  async function bookAppointment() {
    if (!apptWhen) return;
    try {
      await api.clinician.createAppointment({
        patient_id: patientId,
        scheduled_for: new Date(apptWhen).toISOString(),
        kind: apptKind,
        modality: "teleaudiology",
        notes: t("record.appointment.bookedFrom"),
      });
      setApptOpen(false);
      toast(t("record.appointment.booked"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("record.appointment.bookFailed"), "crit");
    }
  }

  async function approvePlan(prescriptionId: number) {
    try {
      await api.therapy.approve(prescriptionId);
      await overview.reload();
      toast(t("record.planApproved"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("record.approveFailed"), "crit");
    }
  }

  if (overview.loading) return <Loading label={t("record.loading")} rows={5} />;
  if (overview.error) return <ErrorState error={overview.error} retry={overview.reload} />;
  if (!overview.data) return null;

  const { patient, trajectory, thi_change, prescriptions, alerts, notes } = overview.data;
  const detail = analysis.data?.analysis;
  const prediction = detail?.prediction;
  const openAlerts = alerts.filter((a: any) => !a.acknowledged_at);
  const activePlan = prescriptions.find((p: any) => p.active);

  return (
    <div className="stack stack-6">
      <header className="row row--between row--top">
        <div className="stack stack-2">
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate("/clinic")}>
            {t("record.backToCaseload")}
          </button>
          <div className="stack stack-1">
            <span className="label label--signal">{t("record.label")}</span>
            <h1>{patient.full_name}</h1>
            <div className="row row--tight">
              <Chip tone="ghost">{patient.mrn}</Chip>
              {patient.age && <Chip tone="ghost">{t("record.years", { count: patient.age })}</Chip>}
              {patient.sex && <Chip tone="ghost">{patient.sex}</Chip>}
              {patient.laterality && <Chip tone="ghost">{patient.laterality}</Chip>}
              {patient.duration_months && <Chip tone="ghost">{fmt.months(patient.duration_months)}</Chip>}
              {patient.pulsatile && <Chip tone="crit">{t("record.pulsatile")}</Chip>}
              {patient.hyperacusis && <Chip tone="warn">{t("record.hyperacusis")}</Chip>}
              {patient.somatic_modulation && <Chip tone="info">{t("record.somatic")}</Chip>}
              {patient.consent_research && <Chip tone="ok">{t("record.researchConsent")}</Chip>}
            </div>
          </div>
        </div>
        <div className="row row--tight">
          <button type="button" className="btn btn--sm" onClick={() => setApptOpen(true)}>
            {t("record.bookFollowUp")}
          </button>
          <button type="button" className="btn btn--sm" onClick={draftNote} disabled={!latestId}>
            {t("record.draftNote")}
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => navigate("/results")}>
            {t("record.fullReport")}
          </button>
        </div>
      </header>

      {/* -- alerts ---------------------------------------------------------- */}
      {openAlerts.length > 0 && (
        <Panel tone="crit" title={t("record.openAlerts", { count: openAlerts.length })} bracketed>
          <div className="stack stack-3">
            {openAlerts.map((alert: any) => (
              <div key={alert.id} className="stack stack-1">
                <div className="row row--tight">
                  <UrgencyChip urgency={alert.evidence?.urgency ?? (alert.severity === "critical" ? "urgent" : "soon")} />
                  <strong style={{ fontSize: "var(--fs-small)" }}>{alert.title}</strong>
                  <span className="meta">{fmt.ago(alert.created_at)}</span>
                </div>
                <p className="meta">{alert.detail}</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* -- daily monitoring between consultations -------------------------- */}
      {/* Only rendered when this patient has actually logged something. An
          empty trend panel on every record trains a clinician to scroll past
          the one that is not empty. */}
      {monitoring.data && monitoring.data.check_in.total_days > 0 && (
        <Panel title={t("monitoring.clinicianTitle")} bracketed>
          <DailyMonitoring monitoring={monitoring.data} onChanged={monitoring.reload} readOnly />
        </Panel>
      )}

      {/* -- headline metrics ------------------------------------------------ */}
      <div className="grid grid-4">
        <Panel tight>
          <Readout
            label={t("record.currentThi")}
            value={trajectory.at(-1)?.thi ?? "—"}
            unit="/100"
            size="md"
            tone={(trajectory.at(-1)?.thi ?? 0) >= 58 ? "crit" : (trajectory.at(-1)?.thi ?? 0) >= 38 ? "warn" : "ok"}
            note={trajectory.at(-1)?.thi_grade}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("record.changeFromBaseline")}
            value={thi_change ? fmt.signed(thi_change.delta, 0) : "—"}
            unit="pts"
            size="md"
            tone={
              thi_change?.direction === "improved" ? "ok" : thi_change?.direction === "worsened" ? "crit" : undefined
            }
            note={thi_change ? `${thi_change.direction}${thi_change.clinically_significant ? " (significant)" : ""}` : undefined}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("record.worseningRisk")}
            value={fmt.pct(prediction?.outputs?.worsening_risk, 0)}
            size="md"
            tone={
              (prediction?.outputs?.worsening_risk ?? 0) >= 0.5
                ? "crit"
                : (prediction?.outputs?.worsening_risk ?? 0) >= 0.25
                  ? "warn"
                  : "ok"
            }
            note={fmt.titleCase(prediction?.outputs?.risk_band)}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("record.assessments")}
            value={overview.data.assessment_count}
            size="md"
            note={`last ${fmt.ago(trajectory.at(-1)?.date)}`}
          />
        </Panel>
      </div>

      {thi_change && (
        <Panel tone={thi_change.direction === "improved" ? "ok" : thi_change.direction === "worsened" ? "crit" : "info"} tight>
          <p style={{ fontSize: "var(--fs-small)" }}>
            THI has moved from <strong>{thi_change.baseline}</strong> to <strong>{thi_change.current}</strong> (
            {fmt.signed(thi_change.delta, 0)} points). {thi_change.note}
          </p>
        </Panel>
      )}

      {/* -- trajectory ------------------------------------------------------ */}
      <Panel title={t("record.trajectory")} bracketed>
        {trajectory.length < 2 ? (
          <EmptyState title={t("record.oneAssessmentTitle")} body={t("record.oneAssessmentBody")} />
        ) : (
          <div className="stack stack-3">
            <TrendChart
              points={trajectory}
              height={260}
              yMax={100}
              yLabel="score"
              series={[
                { key: "thi", label: "THI", color: "var(--signal)", width: 2.6, dots: true },
                { key: "tri", label: "TRI", color: "var(--data)", width: 2, dots: true },
                { key: "psqi", label: "PSQI", color: "var(--warn)", width: 1.3, dashed: true, dots: true },
                { key: "gad7", label: "GAD-7", color: "var(--info)", width: 1.3, dashed: true, dots: true },
              ]}
            />
            <ChartLegend
              items={[
                { label: "THI /100", color: "var(--signal)" },
                { label: "TRI /100", color: "var(--data)" },
                { label: "PSQI /21", color: "var(--warn)", dashed: true },
                { label: "GAD-7 /21", color: "var(--info)", dashed: true },
              ]}
            />
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">THI</th>
                    <th className="num">TRI</th>
                    <th className="num">PSQI</th>
                    <th className="num">GAD-7</th>
                    <th className="num">PSS-10</th>
                    <th className="num">Pitch</th>
                    <th className="num">MML</th>
                    <th className="num">PTA</th>
                  </tr>
                </thead>
                <tbody>
                  {trajectory.map((point: any) => (
                    <tr key={point.assessment_id}>
                      <td>{fmt.date(point.date)}</td>
                      <td className="num">{point.thi ?? "—"}</td>
                      <td className="num">{fmt.num(point.tri, 0)}</td>
                      <td className="num">{point.psqi ?? "—"}</td>
                      <td className="num">{point.gad7 ?? "—"}</td>
                      <td className="num">{point.pss10 ?? "—"}</td>
                      <td className="num">{point.pitch_hz ? fmt.hz(point.pitch_hz) : "—"}</td>
                      <td className="num">{fmt.db(point.mml_db_sl, 1)}</td>
                      <td className="num">{fmt.db(point.pta_better, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {/* -- audiogram + XAI ------------------------------------------------- */}
      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "380px" }}>
        <div className="stack stack-5">
          {analysis.data?.assessment && (
            <Panel title={t("record.latestAudiogram")} bracketed>
              <Audiogram
                audiogram={analysis.data.assessment.audiogram}
                pitchHz={analysis.data.assessment.pitch_match_hz}
                notchHz={analysis.data.assessment.audiometric_notch_hz}
                height={310}
              />
              {/* The hearing test's own flagged review, read straight off the
                  stored assessment. A clinician looking at thresholds is the
                  reader who most needs to know the patient answered three of
                  eight silent checks — without it these look like clean data. */}
              {(analysis.data.assessment as any).audiometry_reliable === false && (
                <Panel tone="warn" tight style={{ marginTop: "var(--s3)" }}>
                  <div className="stack stack-2">
                    <div className="row row--tight">
                      <Chip tone="warn" dot>{t("record.audiometryFlagged")}</Chip>
                      {(analysis.data.assessment as any).audiometry_catch_trials !== null && (
                        <Chip tone="ghost">
                          {(analysis.data.assessment as any).audiometry_false_positives ?? 0}/
                          {(analysis.data.assessment as any).audiometry_catch_trials} false positive
                        </Chip>
                      )}
                      {(analysis.data.assessment as any).audiometry_retest_agreement_db !== null && (
                        <Chip tone="ghost">
                          retest {(analysis.data.assessment as any).audiometry_retest_agreement_db} dB
                        </Chip>
                      )}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: "var(--s5)", fontSize: "var(--fs-tiny)", lineHeight: 1.6 }}>
                      {((analysis.data.assessment as any).audiometry_notes ?? []).map(
                        (note: string, i: number) => (
                          <li key={i}>{note}</li>
                        )
                      )}
                    </ul>
                  </div>
                </Panel>
              )}
              <div className="grid grid-4" style={{ marginTop: "var(--s4)" }}>
                <Readout label={t("record.pitch")} value={fmt.hz(analysis.data.assessment.pitch_match_hz)} unit="Hz" size="sm" tone="signal" />
                <Readout label={t("record.loudness")} value={fmt.db(analysis.data.assessment.loudness_match_db_sl, 1)} unit="dB SL" size="sm" />
                <Readout label={t("record.mml")} value={fmt.db(analysis.data.assessment.mml_db_sl, 1)} unit="dB SL" size="sm" tone="data" />
                <Readout
                  label={t("record.ri")}
                  value={analysis.data.assessment.ri_category ?? "—"}
                  size="sm"
                  tone={analysis.data.assessment.ri_category === "Rebound" ? "crit" : undefined}
                />
              </div>
            </Panel>
          )}

          {prediction && Object.keys(prediction.explanations ?? {}).length > 0 && (
            <Panel title={t("record.modelAttribution")} bracketed>
              <div className="stack stack-5">
                {["worsening_risk", "therapy_response"].map((target) => {
                  const explanation = prediction.explanations[target];
                  if (!explanation) return null;
                  return (
                    <div key={target} className="stack stack-2">
                      <span className="label label--signal">
                        {t(target === "worsening_risk" ? "record.targetWorsening" : "record.targetTherapy")}
                      </span>
                      <ShapWaterfall
                        drivers={explanation.drivers.slice(0, 7)}
                        baseline={explanation.baseline}
                        prediction={explanation.prediction}
                        asPercent
                      />
                      {prediction.narratives?.[target] && <p className="meta">{prediction.narratives[target]}</p>}
                    </div>
                  );
                })}
                <p className="meta dim">
                  {prediction.explanations[Object.keys(prediction.explanations)[0]]?.method}
                </p>
              </div>
            </Panel>
          )}

          {/* -- notes -------------------------------------------------------- */}
          <Panel title={t("record.notes")} bracketed>
            {notes.length === 0 ? (
              <EmptyState
                title={t("record.noNotes")}
                action={
                  <button type="button" className="btn btn--sm" onClick={draftNote}>
                    {t("record.draftOne")}
                  </button>
                }
              />
            ) : (
              <div className="stack stack-4">
                {notes.map((note: any) => (
                  <div key={note.id} className="stack stack-1">
                    <div className="row row--tight">
                      <span className="mono meta">{fmt.dateTime(note.created_at)}</span>
                      {note.ai_draft && <Chip tone="warn">{t("record.aiDraft")}</Chip>}
                    </div>
                    <p style={{ fontSize: "var(--fs-small)", whiteSpace: "pre-wrap" }}>{note.body}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* -- sidebar -------------------------------------------------------- */}
        <div className="stack stack-5">
          <Panel title={t("record.history")} headPlain tight>
            <div className="stack stack-2">
              <Readout label={t("record.character")} value={patient.tinnitus_character ?? "—"} size="sm" />
              <Readout label={t("record.onset")} value={fmt.date(patient.onset_date)} size="sm" note={fmt.months(patient.duration_months)} />
              <Readout
                label={t("record.noiseExposure")}
                value={patient.noise_exposure_years ?? "—"}
                unit={t("record.years_unit")}
                size="sm"
              />
              <Readout
                label={t("record.hearingAids")}
                value={t(patient.hearing_aid_use ? "common.yes" : "common.no")}
                size="sm"
              />
              {patient.comorbidities?.length > 0 && (
                <div className="stack stack-1">
                  <span className="label">Comorbidities</span>
                  <div className="row row--tight">
                    {patient.comorbidities.map((c: string) => (
                      <Chip key={c} tone="ghost">
                        {c}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              {patient.medications?.length > 0 && (
                <div className="stack stack-1">
                  <span className="label">Medication</span>
                  {patient.medications.map((m: string) => (
                    <span key={m} className="meta">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              {patient.etiology_notes && (
                <Disclosure summary={t("record.historyNotes")}>
                  <p className="meta">{patient.etiology_notes}</p>
                </Disclosure>
              )}
            </div>
          </Panel>

          <Panel
            title={t("record.therapyPlan")}
            headPlain
            tight
            aside={
              activePlan ? (
                <Chip tone={activePlan.approved_by_id ? "ok" : "warn"} dot>
                  {t(activePlan.approved_by_id ? "record.approved" : "record.aiDraft")}
                </Chip>
              ) : undefined
            }
          >
            {!activePlan ? (
              <EmptyState title={t("record.noActivePlan")} />
            ) : (
              <div className="stack stack-3">
                <Readout
                  label={t("record.revisionLabel", { revision: activePlan.revision })}
                  value={activePlan.daily_minutes_target}
                  unit="min/day"
                  size="sm"
                  tone="signal"
                  note={t("record.planNote", {
                    blocks: activePlan.blocks,
                    when: fmt.ago(activePlan.created_at),
                  })}
                />
                <Disclosure summary={t("record.clinicalReasoning")} count={activePlan.rationale?.length}>
                  <ol className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-tiny)" }}>
                    {(activePlan.rationale ?? []).map((reason: string, i: number) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ol>
                </Disclosure>
                {!activePlan.approved_by_id && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm btn--block"
                    onClick={() => approvePlan(activePlan.id)}
                  >
                    {t("record.approvePlan")}
                  </button>
                )}
                <button type="button" className="btn btn--sm btn--block btn--ghost" onClick={() => navigate("/rehabilitation")}>
                  {t("record.openPlayerAsPatient")}
                </button>
              </div>
            )}
          </Panel>

          <Panel title={t("record.planHistory")} headPlain tight>
            <div className="stack stack-1">
              {prescriptions.map((p: any) => (
                <div key={p.id} className="row row--between">
                  <span className="meta">
                    {t("record.rev", { revision: p.revision, date: fmt.date(p.created_at) })}
                  </span>
                  <span className="mono meta">{p.daily_minutes_target}m</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* The cochlea belongs on the record, not one click away: the point of
              it is to be on screen while the clinician is talking the patient
              through their own thresholds. */}
          <Panel title={t("record.theirCochlea")} headPlain tight>
            <Suspense fallback={<Loading label={t("record.loading3d")} rows={2} />}>
              <EarModel
                thresholds={overview.data.ear_model?.thresholds}
                pitchHz={overview.data.ear_model?.pitch_match_hz}
                ear={overview.data.ear_model?.ear}
                height={260}
              />
            </Suspense>
            <p className="meta" style={{ marginTop: "var(--s2)" }}>
              Drag to rotate. Hair cells are placed by the Greenwood function and coloured by this
              patient's own thresholds; the marker is their matched percept.
            </p>
          </Panel>

          {/* The "Patient screens" card was removed. It offered a clinician
              buttons into Overview, Therapy, Support and the patient's own
              booking screen while scoped to that patient — routes the router
              already refuses for a clinician, and which would have meant
              reading someone's private counselling history or fabricating data
              on their behalf. The clinical record and Results are the two
              surfaces a clinician needs, and both are already here. */}
        </div>
      </div>

      {/* -- modals ---------------------------------------------------------- */}
      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title={t("record.noteModal.title")}
        footer={
          <>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNoteOpen(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={saveNote} disabled={savingNote || !noteBody.trim()}>
              {t(savingNote ? "record.noteModal.filing" : "record.noteModal.signAndFile")}
            </button>
          </>
        }
      >
        <div className="stack stack-3">
          <Panel tone="warn" tight>
            <p className="meta">
              <Trans i18nKey="record.noteModal.warning" components={[<strong key="0" />]} />
            </p>
          </Panel>
          {noteCodes.length > 0 && (
            <div className="row row--tight">
              {noteCodes.map((code: any) => (
                <Chip key={code.code} tone={code.verify ? "warn" : "ghost"}>
                  {code.code} {code.verify ? t("record.noteModal.verify") : ""}
                </Chip>
              ))}
            </div>
          )}
          <textarea
            className="textarea mono"
            style={{ minHeight: 320, fontSize: "var(--fs-tiny)" }}
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={apptOpen}
        onClose={() => setApptOpen(false)}
        title={t("record.appointment.title")}
        footer={
          <button type="button" className="btn btn--sm btn--primary" onClick={bookAppointment} disabled={!apptWhen}>
            {t("record.appointment.book")}
          </button>
        }
      >
        <div className="stack stack-3">
          <Field label={t("record.appointment.when")}>
            <input className="input" type="datetime-local" value={apptWhen} onChange={(e) => setApptWhen(e.target.value)} />
          </Field>
          <Field label={t("record.appointment.kind")}>
            <select className="select" value={apptKind} onChange={(e) => setApptKind(e.target.value)}>
              <option value="follow_up">{t("record.appointment.follow_up")}</option>
              <option value="review">{t("record.appointment.review")}</option>
              <option value="reassessment">{t("record.appointment.reassessment")}</option>
              <option value="counselling">{t("record.appointment.counselling")}</option>
            </select>
          </Field>
          {activePlan && (
            <p className="meta">
              {t("record.appointment.planSuggests", { days: activePlan.review_after_days ?? 28 })}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
