import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cbse/provider/nifty_stream_provider.dart';

import '../provider/candles_provider.dart';
import '../provider/nifty_provider.dart';
import '../provider/option_stream_provider.dart';
import '../provider/settings_provider.dart';
import '../service/service.dart';
import '../util/chart.dart';
import 'home_page.dart';

class ChartScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<CandleChartData> candleChartData =
        ref.watch(candlesProvider);

    return candleChartData.when(
      loading: () => const CircularProgressIndicator(),
      error: (err, stack) {
        debugPrint('Error $stack');
        return Text('Error: $err');
      },
      data: (data) {
        print(' Data Length: ${data.list.length}');
        return ChartApp(data:data.list);
      },
    );
  }
}
