import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* dashboard screens draw their own shell (sidebar, top bar) */}
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ title: 'Cyfouri' }} />
        <Stack.Screen name="place/[level]/[code]" options={{ title: '' }} />
        <Stack.Screen name="simulator" options={{ title: 'Simulateur' }} />
        <Stack.Screen name="property" options={{ title: 'Analyser un bien' }} />
        <Stack.Screen name="map" options={{ title: 'Carte' }} />
        <Stack.Screen name="method" options={{ title: 'Méthode' }} />
      </Stack>
    </ThemeProvider>
  );
}
