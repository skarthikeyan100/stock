import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../provider/nifty_provider.dart';
import '../provider/nifty_stream_provider.dart';
import '../provider/position_provider.dart';
import '../provider/state/nifty_state.dart';
import '../provider/trade_service_provider.dart';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_typeahead/flutter_typeahead.dart';
import 'package:csv/csv.dart';



class ContractState extends StateNotifier<Map<String, String>> {
  ContractState() : super({'contract': '', 'token': ''});

  void updateContract(String contract, String token) {
    state = {'contract': contract, 'token': token};
  }
}

final contractProvider = StateNotifierProvider<ContractState, Map<String, String>>(
  (ref) => ContractState(),
);

final contractsProvider = FutureProvider<List<Map<String, String>>>((ref) async {
  final String csvString = await rootBundle.loadString('contracts.csv');
  List<List<String>> rows = const CsvToListConverter().convert(csvString);

  List<String> headers = rows.first;
  List<Map<String, String>> mappedData = rows.skip(1).map((row) {
    return Map<String, String>.fromIterables(headers, row);
  }).toList();
  
  return mappedData;
});


class ContractSearchField extends ConsumerWidget {

    final TextEditingController _typeAheadController = TextEditingController();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final contractsAsync = ref.watch(contractsProvider);

    return contractsAsync.when(
      data: (contracts) {
        print("Contracts: $contracts");
        List<Map<String, String>> searchContracts(String query) {
          query = query.trim().toLowerCase();
          List<String> tokens = query.split(' ');

          return contracts.where((item) {
            return tokens.every((token) => item['contract']!.toLowerCase().contains(token));
          }).toList();
        }

        return TypeAheadField<Map<String, String>>(
          suggestionsCallback: searchContracts,
          itemBuilder: (context, suggestion) {
            return ListTile(
              title: Text(suggestion['contract']!),
              subtitle: Text("Token: ${suggestion['token']}"),
            );
          },
          controller: _typeAheadController,
          onSelected: (suggestion) {
            ref.read(contractProvider.notifier).updateContract(suggestion['contract']!, suggestion['token']!);
            _typeAheadController.text = suggestion['contract']!;
            debugPrint('Selected contract is ${suggestion["contract"]}');
          },
        );
      },
      loading: () => CircularProgressIndicator(),
      error: (err, stack) => Text("Error loading contracts"),
    );
  }
}


