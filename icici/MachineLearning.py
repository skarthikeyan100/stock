# Machine Learning
from sklearn import datasets
iris_dataset = datasets.load_iris()
X = iris_dataset.data[:, :2] # First 2 columns
x_count = len(X.flat)
x_min - X[:, 0].min() - .5
x_Max = X[:, 0].max() + .5
x_mean = X[:,0].mean()

Examples:
1. What is market value of this house?
2. Is this email spam?
3. Is there a fraud in this transaction ?

Classification Algorithm: Category is predicted using the data - 
 - Supervised ML
 Ex: Speech recognition, document Classification

 Anamoly Detection Algorithm: Identify unusal data points
 - Is there any fraud in this transaction ?
 - Is someone trying to hack our network ?

 Clustering Algorithm: Group of data based on some condition 
   - Which type of house lies in this segment
   - What type of consumer buys this product

Regression Algorithm 
- What is the market Value of this house?
- Is it rain tomorrow?


import sys
print('Pthyon: {}'.format(sys.version))

import scipy
print('scipy: {}'.format(scipy.version))

import numpy
print('numpy: {}'.format(numpy.version))

import matplotlib
print('matplotlib: {}'.format(matplotlib.version))

import pandas
print('pandas: {}'.format(pandas.version))

#Load Libraries
import pandas
from pandas.plotting import scatter_matrix
import matplotlib.pyplot as plt
from sklearn import model_selection
from sklearn.metrics import classification_report 
from sklearn.metrics import confusion_matrix
from sklearn.metrics import accuracy_score
from sklearn.linear_model import LogisticRegression
from sklearn.tre import DecisionTreeClassifier 
from sklearn.neighbors import KNeighborsClassifier 
from sklearn.discriminant_analysis import LinerDicriminantAnalysis
from sklearn.naive_bayes import GaussianNB
from sklearn.svm import SVC

# Use Panda to load data
url = 'https://archive.ics.uci.edu/ml/machine-learning-databases/iris/iris/iris.data'
names = ['sepal-length', 'sepal-width', 'petal-length', 'petal-width', 'class']
dataset = pandas.read_scv(url, names=names)

print(dataset.shape) # (rows, cols)
print (dataset.head(30) # first 30 rows
print (dataset.describe()) # count, mean, std. min, max, 25%, 50% 75%
print (dataset.groupby()'class').size()) # // Find size of each class

#Visualization
dataset.plot (kind = 'box', subplots = True, layout = (2,2), sharex = False, sharey = False)
plt.show() # ?? How does this work, .plt didnt return a data and plt is from different library ?
dataset.hist() # Histogram
plt.show()

# Multivariant Plot
scatter_matrix(dataset)
plt.show()

# Create a Validation dataset, create a model
array = dataset.values
X = array[:, 0:4]
Y = array[:, 4]
validation_size = 0.20
seed = 6
X_train, X_test, Y_train, Y_test = model_selection.train_test_split(X, Y, test_size = validation_size, random_state = seed)

# Test Harness
# Divide into 10 parts, train on 9 part and test on 10th part
seed = 6
scoring = 'accuracy'

# Use 6 algorithms and compare accuracy

# Spot Check Algorithms
models = []
models.append( ('LR', LogisticRegression()) )
models.append( ('LDA', LinearDiscriminationAnalysis()) )
models.append( ('KNN', KNeighborsClassifier()) )
models.append( ('CART', DecisionTreeClassifier)) )
models.append( ('NB', GuassianNB()) )
models.append( ('SVM', SVC())) )

# Evaluate each model in turn
results = []
names = []

for name, model in models:
    kfold = model_selection.KFold(n_splits=10, random_state = seed)
    cv_results = model_selection.cross_val_score(model, X_train, y_train, cv=kfold, scoring=scoring)
    results.append(cv_results)
    names.append(name)
    msg = "%s: %f (%f)" % (name, cs_results.mean(), cv_results.std())
    print(msg)


## Stats & Probability for Machine Learning
1. What is Data?
Collected, Stored, Measured, Analyzed and Visualized

2. Categories of Data
Qualitative -> Nominal (data with no order and ranking, ex: gender), Ordinal (data has order and ranking, ex: rating)
Quantitative -> Discrete (Finite possible of values, ex: No. of students), Quantinuous (Infinite possible values, ex: weight)
Dependent or Independent data

3. Statistics
 - Data collection, analysis, interpretation and presentation
 EX: Confirm effectiveness of drug, Either or, How to improve business with sales data

 4. Basic Terminologies
  - Population (set of objects or events)
- Sample

5. Sampling Techniques
 - Probability -> Random, Systematic and Stratified
 - Non-probablity (Snowball, Quota, Judgement, Convenience)

 Systematic: Every nth record is chosen for Sampling
 Stratum - subset that shares one common characteristics

 6. Types of statistics
Descriptive - Describe through numerical calculation or graph or table. 
Focuses on main characteristics, provides graphical summary of data
Ex: Max. Avg. Min. T - Shirt size

Inferential: infers and predicts
generalizes a large dataset and applies probability to draw a conclusion

Descriptive Statistics:
---------------------------
Measures of Central Tendency: Mean, Median, Mode
Measures of Variability (Spread): Range, Inter Quartile Range, Variance, Standard Deviation

Measures of Center
---------------------------
Mean -> Average
Median -> Central Value - Arrange in ascending order and take the middle one
Mode -> Most recurrent in the sample set

Measures of Spread (or Dispersion)
---------------------------
Range = Max - Min
Quartile - Break data set into quarters like median breaks into half (Q1, Q2, A3 and Q4). Example: Q1 = (25th + 26th ) / 2
InterQuartileRange - Measure of variability based on quartiles = Q3 - Q1

Variance - How much random variable differs from expected value, it needs square of deviations
s2 = ( Sum ( square(Data point - Mean Data Point) ) ) / Number of data points
Deviation = (x - mean)

Population Variance - average of squared difference from the mean, denominator is number of points 
Sample variance - average of squared difference from the mean, (denominator is number of points - 1)

Information Gain and Entropy
---------------------------
Entropy: Measures impurity or uncertainty present in the data
H(S) = Sum(Pilog2Pi)
Pi -> Event Probability. Logarithm base 2

Information Gain (IG) - How much information a particular feature variable gives us about the final outcome

Gain(A, S) = H(S) - H( A, S) where A is an attribute

Use case: Forecast whether match will be played based on weather conditions
Day, Outlook, Humidity, Wind, played
D1, Sunny | Overcast | Rain, High | Normal, Weak | Strong, No | Y_test

In DecisionTree, have most significant variable ,  Ex: Outlook
Overall: (Yes:9, No: 5)
Entropy = H(S) = (9/14 * log(2) * 9/14) - (5/14) * log(2) * 5/14) = 0.940
Entrop(Windy): 0.048


Overcast (Yes: 4, No: 0) => 100% Success which means Entropy is 0, success rate is 100% means less entropy is better
Sunny: (Yes: 2, No: 3)
Rain: (Yes: 3, No: 2)

Variables: outlook, windy, humidity and tem
Information Gain (Windy): 0.940 - H(A, S) instead of 9/14, use 

H(S) : Consider total instances of true and false, In case of windy, 6 instances are true and 8 instances are false.

so when you consider false, 8/14 . ( )  { Out of 8, 6 are yes and 2 are no. }

Confusion Matrix
---------------------------
Tables that describes performance of a classification model

True (positives + negatives) / ( True  (positives + negatives) + False (positives + negatives) )


Probability
---------------------------
Random Experiment - Process where outcome cannot be predicted with certainty
Sample Space - entire possible set of outcomes (should sum to 1)
Event - outcomes of an experiment
  Disjoint Events - A Card cannot be king and queen
  Joint events - A student gets 100 marks in english and 90 in tamil

Probability Distribution  (02: 05)
---------------------------












