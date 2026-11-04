import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import PlaceScreen from '@/web/screens/place-screen';

export default function PlaceRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Marché · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <PlaceScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
