import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/screen/chart_screen.dart';
import 'package:cbse/screen/home_page.dart';
import 'package:cbse/service/service.dart';
import 'package:cbse/util/chart.dart';
import 'package:cbse/util/hive_helper.dart';
// import 'package:telephony/telephony.dart';

HiveHelper settingsDb = HiveHelper();
HiveHelper appDb = HiveHelper();

// handleMessage(SmsMessage onMessage) async {
//   debugPrint("Message Received from ${onMessage.address}");
//   try {
//     if ('CP-FVASIA' == onMessage.address || 'QP-FVASIA' == onMessage.address) {
//       debugPrint(
//           'Received message ${onMessage.body} from ${onMessage.address}');
//       const prefix = 'Your OTP for Shoonya login is ';
//       if (onMessage.body != null) {
//         String otp =
//             onMessage.body!.substring(prefix.length, prefix.length + 5);
//         debugPrint('Received otp $otp');
//         await Service().login(otp);
//         debugPrint('Logged in successfully');
//         await Service().connect();
//         debugPrint('Connected to websocket');
//       }
//     }
//   } catch (e, s) {
//     debugPrint(e.toString());
//     debugPrint(s.toString());
//   }
// }

_init() async {
  // final Telephony telephony = Telephony.instance;
  // bool? permissionsGranted = await telephony.requestPhoneAndSmsPermissions;
  // debugPrint('permissionsGranted: $permissionsGranted');

  // if (permissionsGranted != null && permissionsGranted) {
  //   debugPrint('Listen Incoming SMS');
  //   telephony.listenIncomingSms(
  //     listenInBackground: true,
  //     onNewMessage: handleMessage,
  //     onBackgroundMessage: handleMessage
      // onBackgroundMessage: handleMessage
      // onNewMessage: (SmsMessage onMessage) async {
      //   debugPrint("Message Received $onMessage");
      //   try {
      //     if ('CP-FVASIA' == onMessage.address) {
      //       print(
      //           'Received message2 ${onMessage.body} from ${onMessage.address}');
      //       const prefix = 'Your OTP for Shoonya login is ';
      //       if (onMessage.body != null) {
      //         String otp =
      //             onMessage.body!.substring(prefix.length, prefix.length + 5);
      //         print('Received otp $otp');
      //         await Service().login(otp);
      //         print('Logged in successfully');
      //         await Service().connect();
      //         print('Connected to websocket');
      //       }
      //     }
      //   } catch (e, s) {
      //     print(e);
      //     print(s);
      //   }
      // }
    // );
  // }
}

void main() async {
  await settingsDb.init('app_settings');
  await appDb.init('app_db');
  await _init();

  runApp(
    ProviderScope(child: MyApp()),
  );
}

class MyApp extends StatelessWidget {
  const MyApp({Key? key}) : super(key: key);

  // This widget is the root of your application.
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Demo',
      theme: ThemeData(
        // This is the theme of your application.
        //
        // Try running your application with "flutter run". You'll see the
        // application has a blue toolbar. Then, without quitting the app, try
        // changing the primarySwatch below to Colors.green and then invoke
        // "hot reload" (press "r" in the console where you ran "flutter run",
        // or simply save your changes to "hot reload" in a Flutter IDE).
        // Notice that the counter didn't reset back to zero; the application
        // is not restarted.
        primarySwatch: Colors.blue,
      ),
      // home: const HomePage(),
      home: const WidgetBindingsObserverSample(),
    );
  }
}

class WidgetBindingsObserverSample extends StatefulWidget {
  const WidgetBindingsObserverSample();

  @override
  State<WidgetBindingsObserverSample> createState() =>
      _WidgetBindingsObserverSampleState();
}

class _WidgetBindingsObserverSampleState
    extends State<WidgetBindingsObserverSample> with WidgetsBindingObserver {
  final List<AppLifecycleState> _stateHistoryList = <AppLifecycleState>[];

  @override
  void initState() {
    super.initState();
    //Reference: Lifecylce state

    WidgetsBinding.instance.addObserver(this);

    if (WidgetsBinding.instance.lifecycleState != null) {
      if (WidgetsBinding.instance.lifecycleState?.name == 'resumed') {
        debugPrint('Can Subscribe Nifty');
      } else {
        debugPrint('Can UnSubscribe Nifty');
      }

      _stateHistoryList.add(WidgetsBinding.instance.lifecycleState!);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state.name == 'resumed') {
      debugPrint('Subscribe');
    } else {
      debugPrint('UnSubscribe');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    debugPrint("Building root component");
    return HomePage();
    // return ChartScreen();
  }
}
