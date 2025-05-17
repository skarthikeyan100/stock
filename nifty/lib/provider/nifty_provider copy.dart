import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:interactive_chart/interactive_chart.dart';

import '../service/service.dart';

class CandleChartData {
  final List<CandleData> list;
  CandleChartData(this.list);
}

final candlesProvider = FutureProvider<CandleChartData>((ref) async {
  List<CandleData> list = await Service().getCandles();
  print("List SIze: ${list.length}");
  return CandleChartData(list);
});
