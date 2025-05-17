import 'package:cbse/model/position.dart';

class PositionList {
  final List<Position> positions;

  PositionList(this.positions);

  static PositionList copy(PositionList state) {
    return PositionList([...state.positions]);
  }
}