import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import MethodScreen from '@/web/screens/method-screen';

export default function MethodRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Méthode et glossaire · Cyfouri</title>
      </Head>
      <MethodScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
