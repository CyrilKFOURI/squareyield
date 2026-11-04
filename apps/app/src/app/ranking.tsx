import { Redirect, useLocalSearchParams } from 'expo-router';

// The ranking is now a preset of the Explorer table (same segment filters, sorted by cash-flow).
export default function RankingRoute() {
  const { type, rooms } = useLocalSearchParams<{ type?: string; rooms?: string }>();
  const params: Record<string, string> = { sort: 'cash_flow_monthly', dir: 'desc' };
  if (type) {
    params.type = type;
  }
  if (rooms) {
    params.size = rooms;
  }
  return <Redirect href={{ pathname: '/explorer', params }} />;
}
