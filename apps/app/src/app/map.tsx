import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import MapScreen from '@/web/screens/map-screen';

export default function MapRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Carte · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <MapScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
