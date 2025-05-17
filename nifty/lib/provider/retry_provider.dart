import 'package:flutter_riverpod/flutter_riverpod.dart';

final retryCountProvider = StateProvider<int>((ref) => 0);