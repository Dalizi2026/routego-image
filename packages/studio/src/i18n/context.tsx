import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { translate, type Language, type MessageKey } from "./dictionaries";

interface I18nValue {
  readonly language: Language;
  readonly setLanguage: (language: Language) => void;
  readonly toggleLanguage: () => void;
  readonly t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({
  children,
  initialLanguage = "zh"
}: {
  readonly children: ReactNode;
  readonly initialLanguage?: Language;
}) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      toggleLanguage: () => setLanguage((current) => (current === "zh" ? "en" : "zh")),
      t: (key) => translate(language, key)
    }),
    [language]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === undefined) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}
