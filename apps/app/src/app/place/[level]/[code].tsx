import { Redirect, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import PlaceScreen from '@/web/screens/place-screen';

export default function PlaceRoute() {
  const raw = useLocalSearchParams<Record<string, string>>();
  const screen = useScreen();
  // a département has its own level page (017): old links land there
  if (raw.level === 'departement' && raw.code) {
    const { level: _level, code, ...rest } = raw;
    return <Redirect href={{ pathname: '/departement/[code]', params: { ...rest, code } }} />;
  }
  return (
    <>
      <Head>
        <title>Marché · SquareYield</title>
        <meta name="robots" content="noindex" />
      </Head>
      <PlaceScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
