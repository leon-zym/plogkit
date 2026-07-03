import { getLocales } from "expo-localization";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";

const deviceLanguage = getLocales()[0]?.languageTag ?? "en";

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-Hans": { translation: zhHans },
  },
  lng: deviceLanguage.startsWith("zh") ? "zh-Hans" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
