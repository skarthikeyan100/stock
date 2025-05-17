import 'dart:convert';

import 'package:cbse/component/contract_search_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/component/reusable.dart';

import '../provider/settings_provider.dart';

class ContractCard extends ConsumerWidget {
  static const Color seaMist = Color(0xFF464196);

  const ContractCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {

    final SettingsState settingsState = ref.watch(settingsProvider);
    final SettingsStateNotifier notifier = ref.read(settingsProvider.notifier);

    return _getScreenWidget(context, settingsState, notifier);

  }

  Widget _getScreenWidget(BuildContext context, SettingsState settingsState, SettingsStateNotifier notifier) {
    // debugPrint('Position Data: ${data.positions}');
    return _getCard(context, settingsState, notifier);
  }


  Card _getCard(
      BuildContext context, SettingsState settingsState, SettingsStateNotifier notifier) {
    //TODO subtract charges
    return Card(
      color: Color(0xFFfefffc),
      margin: EdgeInsets.only(left: 10.0, right: 5.0, top: 20.0, bottom: 20.0),
      elevation: 10.0,
      shape: Reusable.radius5,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          ContractSearchField()
        ],
      ),
    );
  }

}
