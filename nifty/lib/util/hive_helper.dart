import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hive/hive.dart';
import 'package:path_provider/path_provider.dart';

/// A cache access provider class for shared preferences using Hive library
class HiveHelper {
  late Box _preferences;

  getPath() async {
    var path = Directory("/assets/db");
    if (!kIsWeb) {
      var appDocDir = await getApplicationDocumentsDirectory();
      path = appDocDir;
    }
    return path;
  }

  Future<void> init(String boxName) async {
    WidgetsFlutterBinding.ensureInitialized();
    Directory defaultDirectory = await getPath();
    Hive.init(defaultDirectory.path);
    _preferences = await Hive.openBox(boxName);
    print('_preferences: $_preferences');
  }

  get keys => getKeys();

  bool getBool(String key, {bool? defaultValue}) {
    return _preferences.get(key, defaultValue: defaultValue);
  }

  String getString(String key, {String? defaultValue}) {
    return _preferences.get(key, defaultValue: defaultValue);
  }

  num getNumber(String key, {num? defaultValue}) {
    return _preferences.get(key, defaultValue: defaultValue);
  }

  DateTime getDateTime(String key, {DateTime? defaultValue}) {
    return _preferences.get(key, defaultValue: defaultValue);
  }

  Future<void> setObject<T>(String key, T value) {
    return _preferences.put(key, value);
  }

  bool containsKey(String key) {
    return _preferences.containsKey(key);
  }

  Set getKeys() {
    return _preferences.keys.toSet();
  }

  Future<void> remove(String key) async {
    if (containsKey(key)) {
      await _preferences.delete(key);
    }
  }

  Future<void> removeAll() async {
    final keys = getKeys();
    await _preferences.deleteAll(keys);
  }

  Future<void> setBool(String key, bool value) {
    return _preferences.put(key, value);
  }

  Future<void> setNumber(String key, num value) {
    return _preferences.put(key, value);
  }

  Future<void> setString(String key, String value) {
    return _preferences.put(key, value);
  }

  Future<void> setDateTime(String key, DateTime value) {
    return _preferences.put(key, value);
  }
}
