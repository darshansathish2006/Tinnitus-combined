/**
 * Language selector.
 *
 * Appears in four places, and the reason it is in the first two matters: a
 * patient who does not read English cannot be asked to sign in *before* they are
 * allowed to change the language. So this renders on the login and registration
 * screens, in the application top bar once signed in, and in the rail footer.
 *
 * Built as a button-plus-listbox rather than a native `<select>` for one
 * concrete reason: a native option list is rendered by the operating system and
 * inherits neither the page's typography nor its dark theme, so "தமிழ்" and
 * "हिन्दी" landed in whatever fallback face the OS picked. Here they are drawn by
 * the page, in the page's own font stack, and they look like part of the product.
 *
 * Keyboard support is the full listbox contract — arrows, Home/End, Enter,
 * Escape, and focus returned to the trigger on close — because a language
 * selector is disproportionately likely to be reached by someone who is already
 * struggling with the interface.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, languageOf } from "../i18n/languages";
import { useSession } from "../state/session";
import { IconCheck, IconGlobe } from "./icons";

export function LanguageSelector({
  variant = "default",
  align = "end",
}: {
  /**
   * `compact` drops the language name and shows only the globe — for the top
   * bar, where horizontal space is contested. `block` fills its container, for
   * the rail footer and settings forms.
   */
  variant?: "default" | "compact" | "block";
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const locale = useSession((s) => s.locale);
  const setLocale = useSession((s) => s.setLocale);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = languageOf(locale);
  const currentIndex = Math.max(0, LANGUAGES.findIndex((l) => l.code === current.code));

  // Opening should land the highlight on what is already selected, not on the
  // first entry — otherwise Enter silently switches an English reader to Tamil.
  useEffect(() => {
    if (open) setActive(currentIndex);
  }, [open, currentIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  function choose(code: string) {
    void setLocale(code);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((i) => (i + 1) % LANGUAGES.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((i) => (i - 1 + LANGUAGES.length) % LANGUAGES.length);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(LANGUAGES.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(LANGUAGES[active].code);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div className={`langsel${variant === "block" ? " langsel--block" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn--sm langsel__trigger${variant === "block" ? " btn--block" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${t("language.select")} — ${current.native}`}
        title={t("language.select")}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconGlobe size={15} />
        {variant !== "compact" && <span className="langsel__current">{current.native}</span>}
        <span className="langsel__caret" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listId}
          ref={listRef}
          className={`langsel__menu langsel__menu--${align} fade-in`}
          role="listbox"
          tabIndex={-1}
          aria-label={t("language.select")}
          aria-activedescendant={`${listId}-${LANGUAGES[active]?.code}`}
          onKeyDown={onListKeyDown}
        >
          {LANGUAGES.map((language, index) => {
            const selected = language.code === current.code;
            return (
              <div
                key={language.code}
                id={`${listId}-${language.code}`}
                role="option"
                aria-selected={selected}
                className={`langsel__option${index === active ? " langsel__option--active" : ""}`}
                onClick={() => choose(language.code)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="langsel__native" lang={language.code}>
                  {language.native}
                </span>
                {/* The English name stays alongside so a clinician who does not
                    read the script can still tell the entries apart. */}
                <span className="langsel__name">{language.name}</span>
                {selected && <IconCheck size={14} className="langsel__tick" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LanguageSelector;
