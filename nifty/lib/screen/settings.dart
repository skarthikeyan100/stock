import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/nifty_stream_provider.dart';
import 'package:cbse/screen/prism_screen.dart';

import '../provider/nifty_provider.dart';
import '../provider/option_stream_provider.dart';
import '../provider/settings_provider.dart';
import '../service/service.dart';
import 'home_page.dart';

class Settings extends ConsumerWidget {
  static const loginSnackBar = SnackBar(
    content: Text('Requested OTP'),
  );

  static const logoutSnackBar = SnackBar(
    content: Text('Logged out'),
  );

  var hostController = new TextEditingController();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final SettingsState settingsState = ref.watch(settingsProvider);
    final SettingsStateNotifier notifier = ref.read(settingsProvider.notifier);

    return Scaffold(
      body: getScreenWidget(context, settingsState, notifier, ref),
    );
  }


  Widget getScreenWidget(BuildContext context, SettingsState settingsState,
      SettingsStateNotifier notifier, WidgetRef ref) {
    hostController.text = settingsState.host;
    return GestureDetector(
        onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
        child: Scaffold(
          appBar: AppBar(
            title: Text('Application Settings'),
            actions: [
              IconButton(
                  onPressed: () {
                    Navigator.pushReplacement(
                        context,
                        MaterialPageRoute(
                            builder: (BuildContext context) => HomePage()));
                  },
                  icon: Icon(Icons.home))
            ],
          ),
          body: ListView(
            shrinkWrap: true,
            children: <Widget>[
              ListTile(
                title: Text('Depth'),
                subtitle: Text('Choose order size'),
                trailing: DropdownButton(
                    items: const [
                      DropdownMenuItem(child: Text("0"), value: 0),
                      DropdownMenuItem(child: Text("1"), value: 1),
                      DropdownMenuItem(child: Text("2"), value: 2),
                      DropdownMenuItem(child: Text("3"), value: 3),
                      DropdownMenuItem(child: Text("4"), value: 4),
                    ],
                    value: settingsState.depth,
                    onChanged: (int? value) {
                      if (value != null) {
                        notifier.setDepth(value);
                      }
                    }),
              ),
              Divider(),
              ListTile(
                title: Text('Lot Size'),
                subtitle: Text('Choose order size'),
                trailing: DropdownButton(
                    items: const [
                      DropdownMenuItem(child: Text("1"), value: 1),
                      DropdownMenuItem(child: Text("2"), value: 2),
                      DropdownMenuItem(child: Text("4"), value: 4),
                      DropdownMenuItem(child: Text("10"), value: 10),
                      DropdownMenuItem(child: Text("20"), value: 20),
                      DropdownMenuItem(child: Text("30"), value: 30),
                      DropdownMenuItem(child: Text("40"), value: 40),
                      DropdownMenuItem(child: Text("72"), value: 72),
                    ],
                    value: settingsState.lotSize,
                    onChanged: (int? value) {
                      if (value != null) {
                        notifier.setLotSize(value);
                      }
                    }),
              ),
              Divider(),
              ListTile(
                title: TextField(
                  // controller: hostController,
                  decoration: InputDecoration(
                      border: OutlineInputBorder(),
                      labelText: 'Host',
                      hintText: 'Enter Your Host'),
                   onChanged: (value) {
                    notifier.setHost(value);
                  },
                ),
                // trailing: TextField(
                //   onChanged: (value) {
                //     notifier.setHost(value);
                //   },
                // )
              ),
              Divider(),
              ListTile(
                title: TextField(
                  decoration: InputDecoration(
                      border: OutlineInputBorder(),
                      labelText: 'Prism OTP',
                      hintText: 'Enter Your OTP to login in Prism'),
                  onChanged: (value) {
                    notifier.setOtp(value);
                  },
                ),
                trailing: SizedBox(
                    width: 200,
                    height: 50,
                    child: Padding(
                        padding: EdgeInsets.only(left: 10),
                        child: ElevatedButton(
                            child: Text('Login'),
                            onPressed: () async {
                              await Service().login(settingsState.otp);
                              ScaffoldMessenger.of(context)
                                  .showSnackBar(loginSnackBar);
                                   Navigator.pushReplacement(
                              context,
                              MaterialPageRoute(
                                  builder: (context) => HomePage(connected: true)),
                            );
                            }))),
              ),
              Divider(),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  SizedBox(
                      width: 200,
                      height: 50,
                      child: ElevatedButton(
                          child: Text('Request OTP'),
                          onPressed: () async {
                            await Service().requestOtp();
                            ScaffoldMessenger.of(context)
                                .showSnackBar(loginSnackBar);
                          })),
                  SizedBox(
                      width: 200,
                      height: 50,
                      child: ElevatedButton(
                          child: Text('Connect'),
                          onPressed: () async {
                            await Service().connect();
                            ScaffoldMessenger.of(context)
                                .showSnackBar(logoutSnackBar);
                            Navigator.pushReplacement(
                              context,
                              MaterialPageRoute(
                                  builder: (context) => HomePage(connected:true)),
                            );
                          })),
                ],
              )
            ],
          ),
        ));
  }
}
