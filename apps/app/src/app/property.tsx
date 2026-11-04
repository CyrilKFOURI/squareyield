import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import PropertyScreen from '@/web/screens/property-screen';

export default function PropertyRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Analyser un bien · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <PropertyScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
