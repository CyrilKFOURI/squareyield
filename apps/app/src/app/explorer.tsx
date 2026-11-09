import { Redirect, useLocalSearchParams } from 'expo-router';

// Explorer became Investir ① "Trouver une ville" (017): old links keep their filters.
export default function ExplorerRoute() {
  const params = useLocalSearchParams<Record<string, string>>();
  return <Redirect href={{ pathname: '/investir', params }} />;
}
