import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="home-screen">
      <Text style={styles.title}>{t("home.title")}</Text>
      <Text style={styles.tagline}>{t("home.tagline")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
  },
  tagline: {
    fontSize: 15,
    textAlign: "center",
    opacity: 0.6,
  },
});
